function remove__(time) {
  let replaced = time.replace(/__\d+/, "");
  return replaced.trim();
}

function seconds_past_midnight(time) {
  let date = new Date(); // create a new date object representing the current date and time
  date.setHours(0, 0, time); // set the hours, minutes, and seconds of the date based on the seconds past midnight
  let hours = date.getHours(); // get the hours from the date object
  let minutes = date.getMinutes(); // get the minutes from the date object
  let seconds = date.getSeconds(); // get the seconds from the date object

  return (militaryTime =
    hours.toString().padStart(2, "0") +
    ":" +
    minutes.toString().padStart(2, "0") +
    ":" +
    seconds.toString().padStart(2, "0")); // combine hours, minutes, and seconds with padding
}

module.exports = { remove__, seconds_past_midnight };
