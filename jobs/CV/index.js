const ge_cv_sysError = require("./sysError_parser");
const GE_CT_CV_MRI = require("../../acquisition/GE_CT_CV_MRI");
const { gzip_n_save } = require("../../tooling");
const { dt_now } = require("../../tooling/dates");
const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, cat }
} = require("../../utils/logger/enums");

const ge_cv_parsers = async (job_id, sysConfigData, run_log) => {
  let note = {
    job_id: job_id,
    sme: sysConfigData.id
  };
  try {
    await addLogEvent(I, run_log, "ge_cv_parsers", cal, note, null);
    for await (const file of sysConfigData.log_config) {
      const capture_datetime = dt_now();

      switch (file.dir_name) {
        case "sysError":
          const System = new GE_CT_CV_MRI(sysConfigData, file, job_id, run_log);
          await ge_cv_sysError(System, capture_datetime);
          break;
        default:
          break;
      }

      // SAVE LOG

      let path = `${sysConfigData.debian_server_path}/${file.file_name}`;

      await gzip_n_save(
        job_id,
        run_log,
        sysConfigData.id,
        file.file_name,
        capture_datetime,
        path
      );
    }
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "ge_cv_parsers", cat, note, error);
  }
};

module.exports = ge_cv_parsers;
