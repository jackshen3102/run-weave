/* global document, sessionStorage */
import { text } from "./value.js";
document.querySelector("#value").textContent = text;
sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1);
document.querySelector("#loads").textContent =
  "页面加载次数 " + sessionStorage.loads;
if (import.meta.hot)
  import.meta.hot.accept("./value.js", (mod) => {
    document.querySelector("#value").textContent = mod.text;
  });
