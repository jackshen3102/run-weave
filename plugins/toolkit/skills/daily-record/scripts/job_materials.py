"""Opt-in user supplied materials, with separate scan and consumption checkpoints."""
import base64
import copy
import hashlib
from pathlib import Path
from job_state import directory, read, require, stamp, window, write, materials_enabled


def client_for(c, suiji):
    connection = read(c["suiji"]["configPath"])
    client, info = suiji.connect(connection, c["suiji"]["tokenFile"])
    require(info.get("features", {}).get("materials") and info.get("features", {}).get("workMaterials"), "MATERIALS_UNAVAILABLE")
    require(c["sources"]["materials"]["accountScope"] == info["serverId"] + ":" + info["ownerId"], "MATERIAL_ACCOUNT_MISMATCH")
    return client


def scope(c):
    return "materials:" + c["sources"]["materials"]["accountScope"]


def reconcile(state, suiji):
    if not materials_enabled(state.c):
        return
    client = client_for(state.c, suiji)
    snapshot = copy.deepcopy(state.data.get("materials", {"cursor": None, "records": {}}))
    cursor, changed = snapshot["cursor"], set()
    while True:
        page = client.call("list_changes", {"limit": 50, **({"cursor": cursor} if cursor else {})})
        for item in page["items"]:
            if item["kind"] == "followup_added":
                continue
            changed.add(item["recordId"])
        require(page["nextCursor"] != cursor or not page["hasMore"], "MATERIAL_CHANGE_CURSOR_STUCK")
        cursor = page["nextCursor"]
        if not page["hasMore"]:
            break
    affected = set()
    for record_id in sorted(changed):
        old = snapshot["records"].get(record_id)
        if old:
            affected.add(old["material"]["materialDate"])
        try:
            record = client.call("get_record", {"recordId": record_id})["record"]
        except suiji.Failure as error:
            if str(error) != "NOT_FOUND":
                raise
            record = None
        if record and record.get("material") and not record.get("deletedAt"):
            snapshot["records"][record_id] = record
            affected.add(record["material"]["materialDate"])
        else:
            snapshot["records"].pop(record_id, None)
    snapshot["cursor"] = cursor
    state.data["materials"] = snapshot
    for day in affected:
        if materials_enabled(state.c, day):
            state.data["days"].setdefault(day, {})["complete"] = False
    # Index and cursor commit atomically. Consumption is only confirmed after publish readback.
    write(state.file, state.data)


def rows(state, day, bundle, suiji):
    client = client_for(state.c, suiji)
    directory(bundle)
    result, complete = [], True
    for expected in state.data.get("materials", {}).get("records", {}).values():
        if expected["material"]["materialDate"] != day:
            continue
        record = client.call("get_record", {"recordId": expected["id"]})["record"]
        material = record.get("material")
        require(material and not record.get("deletedAt") and material["sourceHash"] == expected["material"]["sourceHash"], "MATERIAL_VERSION_CHANGED: recollect")
        images, image_error = [], False
        for attachment in record["attachments"]:
            if attachment["kind"] != "image":
                # First release consumes image/text/link only. Do not claim an unread attachment.
                image_error = True
                continue
            try:
                value = client.call("read_attachment", {"attachmentId": attachment["id"]})
                blocks = [b for b in value.get("content", []) if b.get("type") == "image"]
                metadata = value.get("structuredContent", {})
                require(len(blocks) == 1 and metadata.get("attachmentId") == attachment["id"], "MATERIAL_IMAGE_IDENTITY_MISMATCH")
                data = base64.b64decode(blocks[0]["data"], validate=True)
                sha = hashlib.sha256(data).hexdigest()
                require(len(data) == attachment["byteSize"] and blocks[0]["mimeType"] == attachment["mimeType"] and metadata.get("sha256") == sha, "MATERIAL_IMAGE_CONTENT_MISMATCH")
                path = bundle / (attachment["id"] + (".png" if attachment["mimeType"] == "image/png" else ".jpg"))
                with path.open("wb") as stream:
                    stream.write(data)
                path.chmod(0o600)
                images.append({"attachmentId": attachment["id"], "path": str(path), "sha256": sha})
            except Exception:
                image_error = True
        current = client.call("get_record", {"recordId": record["id"]})["record"]
        require(current.get("material", {}).get("sourceHash") == material["sourceHash"], "MATERIAL_VERSION_CHANGED: recollect")
        complete = complete and not image_error
        result.append({"id": "material:" + record["id"], "day": day, "role": "user", "text": record["body"],
                       "anchor": scope(state.c) + ":" + record["id"], "project": None, "images": images, "imageError": image_error,
                       "material": material, "ref": {"channel": "suiji-material", "sourceScope": scope(state.c),
                       "nativeId": record["id"], "revision": str(record["version"]), "hash": material["sourceHash"]}})
    return result, {"sourceScope": scope(state.c), "status": "complete" if complete else "partial", "collectedAt": stamp(), **window(day)}


def acknowledge_image(path, meta, material, receipt_path):
    """Executor calls only AFTER passing the actual image to its vision-capable model."""
    require(material["ref"]["channel"] == "suiji-material" and material["images"], "IMAGE_MATERIAL_REQUIRED")
    receipt = read(receipt_path)
    require(set(receipt) == {"materialId", "sourceHash", "reader", "toolCallId", "images", "observation"}, "INVALID_IMAGE_READ_RECEIPT")
    require(receipt["materialId"] == material["id"] and receipt["sourceHash"] == material["ref"]["hash"], "IMAGE_READ_VERSION_MISMATCH")
    require(all(isinstance(receipt[k], str) and receipt[k].strip() for k in ("reader", "toolCallId", "observation")), "ACTUAL_VISION_READ_REQUIRED")
    expected = [{"attachmentId": i["attachmentId"], "sha256": i["sha256"]} for i in material["images"]]
    require(receipt["images"] == expected, "IMAGE_READ_IDENTITY_MISMATCH")
    for item in material["images"]:
        require(hashlib.sha256(Path(item["path"]).read_bytes()).hexdigest() == item["sha256"], "IMAGE_FILE_CHANGED")
    meta.setdefault("imageReads", {})[material["id"]] = receipt
    write(path / (material["ref"]["nativeId"] + "-image-read.json"), receipt)
    return {"acknowledged": material["id"], "sourceHash": material["ref"]["hash"]}


def results(materials, candidates, meta, exported):
    source = {m["id"]: m for m in materials if m["ref"]["channel"] == "suiji-material"}
    reviews = candidates.get("materialReviews", [])
    require(isinstance(reviews, list) and len(reviews) == len(source) and {r.get("id") for r in reviews} == set(source), "REVIEW_EVERY_MATERIAL: include deferred when vision is unavailable")
    output = []
    for review in reviews:
        require(set(review) == {"id", "outcome", "reason"} and review["outcome"] in ("included", "merged", "no-new-fact", "deferred") and isinstance(review["reason"], str) and review["reason"].strip(), "INVALID_MATERIAL_REVIEW")
        m = source[review["id"]]
        facts = [f for day in exported for f in day["facts"] if any(r["channel"] == "suiji-material" and r["nativeId"] == m["ref"]["nativeId"] for r in f["sourceRefs"])]
        if review["outcome"] == "deferred":
            require(not facts, "DEFERRED_MATERIAL_CANNOT_PROVE_FACT")
            for day in exported:
                if day["date"] == m["day"]:
                    for r in day["receipts"]:
                        if r["sourceScope"] == m["ref"]["sourceScope"]:
                            r["status"] = "partial"
            continue
        require(not m["imageError"], "MATERIAL_ATTACHMENT_UNREAD")
        if m["images"]:
            receipt = meta.get("imageReads", {}).get(m["id"], {})
            require(receipt.get("sourceHash") == m["ref"]["hash"], "ACTUAL_VISION_READ_REQUIRED: text read does not read images")
            for image in m["images"]:
                require(hashlib.sha256(Path(image["path"]).read_bytes()).hexdigest() == image["sha256"], "IMAGE_FILE_CHANGED")
        require(bool(facts) == (review["outcome"] != "no-new-fact"), "MATERIAL_OUTCOME_FACT_MISMATCH")
        output.append({"recordId": m["ref"]["nativeId"], "recordVersion": int(m["ref"]["revision"]), "sourceHash": m["ref"]["hash"],
                       "outcome": review["outcome"], "eventKeys": sorted({f["eventKey"] for f in facts})})
    return output


def verify_versions(c, payload, suiji):
    if not payload.get("materialResults"):
        return
    client = client_for(c, suiji)
    for item in payload["materialResults"]:
        record = client.call("get_record", {"recordId": item["recordId"]})["record"]
        require(record.get("material", {}).get("sourceHash") == item["sourceHash"] and record["version"] == item["recordVersion"], "MATERIAL_VERSION_CHANGED: recollect before publishing")
