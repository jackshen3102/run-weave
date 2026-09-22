// Applied migrations are immutable. Add a new numbered migration instead.
export const catchUpDataSql = `
  UPDATE scheduled_tasks
  SET payload_json = json_set(payload_json, '$.misfirePolicy', json('{"mode":"skip"}'))
  WHERE json_type(payload_json, '$.misfirePolicy') IS NULL;

  UPDATE scheduled_runs
  SET payload_json = json_set(payload_json, '$.snapshot.misfirePolicy', json('{"mode":"skip"}'))
  WHERE json_type(payload_json, '$.snapshot.misfirePolicy') IS NULL;

  UPDATE scheduled_runs
  SET payload_json = json_set(payload_json, '$.dispatch', NULL)
  WHERE json_type(payload_json, '$.dispatch') IS NULL;
`;
