import { Queue } from "bullmq";
import IORedis from "ioredis";
import { cfg } from "./config.js";

export const connection = new IORedis(cfg.redisUrl, {
  maxRetriesPerRequest: null,
});
const defaultJobOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false, // keep failed jobs for inspection / retry
};
export const contactQueue = new Queue("contact-sync", {
  connection,
  defaultJobOptions,
});
export const noteQueue = new Queue("note-sync", {
  connection,
  defaultJobOptions,
});

// jobId makes enqueue idempotent (BullMQ ignores duplicates of an active/waiting id)
export const enqueueContactPage = (accountId, after, fresh = false) =>
  contactQueue.add(
    "page",
    { accountId, after: after || null },
    {
      jobId: `c-${accountId}-${after || "start"}${
        fresh ? "-" + Date.now() : ""
      }`,
    }
  );

export const enqueueNote = (noteId) =>
  noteQueue.add("push", { noteId }, { jobId: `n-${noteId}` });
