const { DateTime } = require("luxon");

async function convertDT(date) {
  const date_format_tests = {
    re_1: /\d{4}-\d+-\d{2}/,
    re_2: /\d{2}-[A-Z]+-\d{4}/
  };

  let formatted_date;

  if (date_format_tests.re_1.test(date)) {
    formatted_date = DateTime.fromFormat(`${date}`, "yyyy-MM-dd");
  }
  if (date_format_tests.re_2.test(date)) {
    formatted_date = DateTime.fromFormat(`${date}`, "dd-MMM-yyyy");
  }

  let newDate = new Date(formatted_date.plus({ hours: 5 }).toISO());
  return newDate;
}

async function compare_dates(date) {
  const now = new Date();

  const time_delta = Math.abs(now - date);

  // Calculate diff in hours
  const hours_delta = parseFloat((time_delta / (60 * 60 * 1000)).toFixed(1));

  return hours_delta;
}

const dt_from_pattern = async (dtString, inputPattern, ianaTz) => {
  if (!ianaTz) ianaTz = "America/New_York";

  return DateTime.fromFormat(dtString, inputPattern, {
    zone: ianaTz
  }).toISO();
};

function dt_now() {
  return DateTime.now().setZone("America/New_York").toISO();
}

module.exports = { convertDT, compare_dates, dt_now, dt_from_pattern };
