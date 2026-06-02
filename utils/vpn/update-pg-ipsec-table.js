const db = require("../db/pg-pool");
const {
  get_ipsec_data,
  format_api_data,
  set_to_map,
  additions_to_ipsec_table,
  insert_into_db
} = require("./ipsec-update-util");

const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../logger/enums");
const [addLogEvent] = require("../logger/log");

const update_pg_ipsec = async (run_log) => {
  addLogEvent(I, run_log, "update_pg_ipsec", cal, null, null);
  try {
    // GET util.ip_sec DATA FROM POSTGRESQL
    const pq = `SELECT * FROM util.ip_sec`;
    const pg_ipsec_table = await db.any(pq);

    // GET ipsec DATA FROM API
    const ipsec_data = await get_ipsec_data(run_log);

    // SET BOTH POSTGRESQL AND API DATA TO MAP STRUCTURE
    // EX: pg_ipsec_map.get('ip_address') RETURNS OBJECT WITH remote_subnet_ip, remote_subnet_mask, endpoint_id, tunnel_id
    const ipsec_map = format_api_data(ipsec_data, run_log);
    const pg_ipsec_map = set_to_map(
      pg_ipsec_table,
      "remote_subnet_ip",
      run_log
    );

    // AN ARRAY OF OBJECTS TO ADD TO util.ip_sec TABLE
    const add_to_db = additions_to_ipsec_table(
      ipsec_map,
      pg_ipsec_map,
      run_log
    );

    // IF NEW IP ADDRESSES EXIST, INSERT INTO util.ip_sec
    if (add_to_db.length) {
      await insert_into_db(add_to_db, run_log);
    }
  } catch (error) {
    addLogEvent(I, run_log, "update_pg_ipsec", cal, null, error);
  }
};

module.exports = update_pg_ipsec;
