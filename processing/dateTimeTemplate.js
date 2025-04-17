const { DateTime } = require("luxon");

const dateTimeTemplate = async (
  jobId,
  sme,
  dtString,
  inputPattern,
  ianaTz
) => {

  return DateTime.fromFormat(dtString, inputPattern, {
    zone: ianaTz,
  }).toISO();
};

const date_minus_one_template = async (
  jobId,
  sme,
  dtString,
  inputPattern,
  ianaTz
) => {

  let date = DateTime.fromFormat(dtString, inputPattern, {
    zone: ianaTz,
  });

  return date.minus({ days: 1 }).toISO();
};

module.exports = {dateTimeTemplate, date_minus_one_template};