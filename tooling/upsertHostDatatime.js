function build_upsert_str(sme, resent_host_datetime) {
  const upsert_str = `
INSERT INTO
alert.offline_hhm_conn (system_id, rpp_host_datetime)
VALUES
  ('${sme}', '${resent_host_datetime}') ON CONFLICT (system_id) DO
UPDATE
SET
  rpp_host_datetime = EXCLUDED.rpp_host_datetime;
    `;

  return upsert_str;
}

module.exports = build_upsert_str;
