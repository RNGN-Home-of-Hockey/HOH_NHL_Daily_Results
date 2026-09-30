import assert from "node:assert/strict";
import { broadcastLengthEligible } from "../cloudflare-worker/src/telegram-center-vk-maintenance.js";

assert.equal(
  broadcastLengthEligible({title:"Филадельфия — Питтсбург",status:"upcoming",duration_seconds:0}),
  true,
  "scheduled live stream with duration 0 must remain eligible before puck drop",
);
assert.equal(
  broadcastLengthEligible({title:"Филадельфия — Питтсбург",status:"live",duration_seconds:0}),
  true,
  "live stream with duration 0 must remain eligible",
);
assert.equal(
  broadcastLengthEligible({title:"Филадельфия — Питтсбург",status:"recorded",duration_seconds:0}),
  false,
  "zero-duration recorded video must not become a canonical match broadcast",
);
assert.equal(
  broadcastLengthEligible({title:"Хайлайты: Филадельфия — Питтсбург",status:"upcoming",duration_seconds:0}),
  false,
  "highlight titles must never be treated as the full match broadcast",
);
assert.equal(
  broadcastLengthEligible({title:"Филадельфия — Питтсбург",status:"recorded",duration_seconds:900}),
  false,
  "short recorded clips must stay ineligible",
);
assert.equal(
  broadcastLengthEligible({title:"Филадельфия — Питтсбург",status:"recorded",duration_seconds:7200}),
  true,
  "full-length recorded broadcasts stay eligible",
);

console.log("VK_UPCOMING_BROADCAST_ELIGIBILITY_OK");
