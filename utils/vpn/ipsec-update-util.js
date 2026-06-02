const pgp = require("pg-promise")();
const db = require("../db/pg-pool");
const axios = require("axios");
const https = require("https");
const fs = require("fs/promises");
// const test_data = require("../../ipsec_data.json");

const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../logger/enums");
const [addLogEvent] = require("../logger/log");

const get_ipsec_data = async (run_log) => {
  addLogEvent(I, run_log, "get_ipsec_data", cal, null, null);

  const url = `https://${process.env.VNS3_IP}:8000/api/status/ipsec`;
  const agent = new https.Agent({
    rejectUnauthorized: false
  });
  const pw = process.env.VNS3_PW;
  const options = {
    httpsAgent: agent,
    headers: {
      Accept: "application/json",
      Authorization: "Basic " + Buffer.from("api:" + pw).toString("base64")
    }
  };

  // GET THE IPSEC PAYLOAD
  try {
    const res = await axios.get(url, options);
    const ipsec_status = res?.data;

    let note = { ipsec_status: ipsec_status };
    addLogEvent(I, run_log, "get_ipsec_data", det, note, null);

    /* BLOCK USED TO SAVE API DATA FOR REPETITIVE USE/TESTING

    const dataToWrite = JSON.stringify(res.data.response);

    await fs.writeFile("ipsec_data.json", dataToWrite); 
    */

    return res.data.response;
  } catch (error) {
    console.log(error);
    addLogEvent(E, run_log, "get_ipsec_data", cat, note, error);
  }
};

function format_api_data(api_data, run_log) {
  addLogEvent(I, run_log, "format_api_data", cal, null, null);
  const remote_subnet_regEx =
    /(?<remote_subnet_ip>\d.+)\/(?<remote_subnet_mask>\d+)/;

  const ipsec_map = new Map();
  for (const obj in api_data) {
    let matches = api_data[obj].remote_subnet.match(remote_subnet_regEx);

    let ip_obj = {
      remote_subnet_ip: matches.groups.remote_subnet_ip,
      remote_subnet_mask: matches.groups.remote_subnet_mask,
      endpoint_id: api_data[obj].endpoint_id,
      tunnel_id: api_data[obj].tunnel_id
    };

    ipsec_map.set(ip_obj.remote_subnet_ip, ip_obj);
    ip_obj = {};
  }

  return ipsec_map;
}

function set_to_map(array, map_key, run_log) {
  addLogEvent(I, run_log, "set_to_map", cal, { map_key }, null);
  const map = new Map();
  for (const obj of array) {
    map.set(obj[map_key], obj);
  }

  return map;
}

function additions_to_ipsec_table(ipsec_map, pg_ipsec_map, run_log) {
  addLogEvent(I, run_log, "additions_to_ipsec_table", cal, null, null);
  const insert_into_db = [];

  ipsec_map.forEach((value, key) => {
    let is_in_db = pg_ipsec_map.get(key);
    if (!is_in_db) insert_into_db.push(ipsec_map.get(key));
  });

  addLogEvent(
    I,
    run_log,
    "additions_to_ipsec_table",
    det,
    { add_to_db: insert_into_db },
    null
  );

  return insert_into_db;
}

async function insert_into_db(add_to_db, run_log) {
  addLogEvent(I, run_log, "insert_into_db", cal, { add_to_db }, null);
  const cs = new pgp.helpers.ColumnSet(
    ["remote_subnet_ip", "remote_subnet_mask", "endpoint_id", "tunnel_id"],
    { table: { table: "ip_sec", schema: "util" } }
  );

  const query = pgp.helpers.insert(add_to_db, cs);

  try {
    await db.none(query);
  } catch (error) {
    console.log(error);
    addLogEvent(I, run_log, "insert_into_db", cal, null, error);
  }
}

module.exports = {
  get_ipsec_data,
  format_api_data,
  set_to_map,
  additions_to_ipsec_table,
  insert_into_db
};
