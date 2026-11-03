"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { scrub_message, scrub_type } = require("../tools/scrub");

test("scrubs exam numbers in every seen notation", () => {
  assert.strictEqual(scrub_message("Start: Prospective Exam: 14328 : Protocol: 5.1\n"), "Start: Prospective Exam: 10001 : Protocol: 5.1\n");
  assert.strictEqual(scrub_message("used for exam 14328. Max"), "used for exam 10001. Max");
  assert.strictEqual(scrub_message("Starting recon job for Exam Number: 5132, Series"), "Starting recon job for Exam Number: 10001, Series");
  assert.strictEqual(scrub_message("exam=5132, series=12"), "exam=10001, series=12");
  assert.strictEqual(scrub_message("image E5132/S1/I1 event"), "image E10001/S1/I1 event");
});

test("scrubs host ids, remote hosts, DICOM destinations, UIDs and IPs", () => {
  assert.match(scrub_message("|host_id: 1943699096|tube_type: 23"), /host_id: 0\|/);
  assert.strictEqual(scrub_message("to host='MCKESSON' sent"), "to host='HOST' sent");
  for (const m of ["Sent:  2229/11 (AIDOC)\n", "Start Sending:  15411/997/... (NSFRTAW)\n", "Start Sending:  2175 (Imalogix)\n"]) {
    assert.match(scrub_message(m), /\(DEST\)\n$/);
  }
  assert.strictEqual(scrub_message("image_set_id=1.2.840.113619.2.290.3.336205071.126.1793727087.190 num"), "image_set_id=1.2.3.4.5 num");
  assert.strictEqual(scrub_message("peer 10.14.1.177 down"), "peer 0.0.0.0 down");
  assert.strictEqual(scrub_type("gectpet\tscanRx"), "HOST\tscanRx");
});

test("leaves rule-relevant numbers alone", () => {
  const m = "The current tube usage data reports a total of 71243584.0 ma*S.\n";
  assert.strictEqual(scrub_message(m), m);
  assert.strictEqual(scrub_message("Tube temperature before Air Calibration is 486.08 degrees Celsius.\n"), "Tube temperature before Air Calibration is 486.08 degrees Celsius.\n");
});
