"use strict";
// Templates deliberately NOT turned into metrics (PLAN-CT-INSIGHTS.md §8
// Phase 2 criterion: every template above 500 rows/30 d has a rule or an
// entry here). status: "ignore" = noise, "watch" = candidate metric kept
// visible in the coverage report. Matched against the raw message (and the
// process when given). Agreed with the user 2026-11-03 (§12.1).
const ignore = [
  // ---- watch: candidate metrics, not yet built
  { status: "watch", re: /Failed to get thermal state from scanmgr|uifIpcSendRecvTubeStateRequest|Previous send operation error was part of a combined send and receive operation/, reason: "exam Rx <-> scan manager tube-state comm errors (~20 systems)" },
  { status: "watch", re: /Removing ISR for scan \S+ because we can't even make/, reason: "recon could not make an image (~19 systems)" },
  { status: "watch", re: /Scan Prep: Prospective Exam:/, reason: "per-scan prep event (3 newer-sw systems); possible utilization detail" },
  { status: "watch", re: /No system function reported[\s\S]*Lost Communication/, reason: "fwmgr lost communication" },
  { status: "watch", re: /This message was added by the OPERATOR to report on a problem:\s*InSite Logged (In|Out)/, reason: "GE InSite remote-service sessions" },
  { status: "watch", re: /View corrections were applied in view/, reason: "image generation view corrections (~15 systems); possibly detector-related" },

  // ---- ignore: routine noise
  { status: "ignore", re: /RSvr: (Starting recon job|Series Recon completed successfully)/, reason: "recon job progress" },
  { status: "ignore", re: /Start processing image_set_id=/, reason: "recon job progress" },
  { status: "ignore", re: /Info: database checkpoint was performed/, reason: "database housekeeping" },
  { status: "ignore", re: /Service name\s+(not found in GE services file|\S+ is not known)/, reason: "service registry lookups" },
  { status: "ignore", re: /EV_SCOUT_SEGMENT_AVAILABLE with status \d+\s*Ecomm send Failed/, reason: "image-creation UI notification" },
  { status: "ignore", re: /^Status update: (Starting Review|Start session|Found film composer|Attempting to start film composer)/, reason: "review / film composer status" },
  { status: "ignore", re: /Ecomm internal error detected/, reason: "generic ecomm chatter (every process)" },
  { status: "ignore", re: /Detected ecomm disconnect from process uif_/, reason: "UI process disconnects" },
  { status: "ignore", re: /IPC failure caused by cupIpcConnect from uif_/, reason: "UI process IPC connects" },
  { status: "ignore", re: /ecomm_send_msg\(\) failed to send IQS_IMAGE_REQUEST/, reason: "UI image queue" },
  { status: "ignore", re: /SIRx read of config files failed with status \d+ within New Patient processing/, reason: "config read on new patient (status 0)" },
  { status: "ignore", re: /Exclusion Test - Row .* PASSED CHECKS/, reason: "detector channel test passed" },
  { status: "ignore", re: /Callback function for normal user callback already registered/, reason: "scanfile_xfer startup" },
  { status: "ignore", re: /All Plug n Play Devices are operational and ready for use/, reason: "device check passed" },
  { status: "ignore", re: /DisplayMgrControl::displayMgrTimerExec\(\) WARNING/, reason: "display manager timer" },
  { status: "ignore", re: /logCopyForwardForNewSeries: Series Copy Forward/, reason: "series copy-forward setting" },
  { status: "ignore", re: /Failure to get DCM event:\s*no event occured/, reason: "dcserver idle poll" },
  { status: "ignore", re: /No system function reported[\s\S]*Failure sending event/, reason: "fwmgr event send while idle" },
];
module.exports = { ignore };
