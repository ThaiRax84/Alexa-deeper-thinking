// Processes one research job: research (or reuse a saved result), deliver, record.
import { ModelResolutionError } from "@deeper-thinking/core";
import { jobSk, reportKey } from "@deeper-thinking/aws";
import { DeliveryError, renderEmail } from "./delivery.js";

export class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
    this.permanent = true;
  }
}

/** Errors that will not go away by retrying. */
export const isPermanent = (e) =>
  e?.permanent === true ||
  e instanceof ModelResolutionError ||
  (e?.name === "ProviderError" && (e.kind === "auth" || e.kind === "bad_request")) ||
  e?.message === "Unreadable secret.";

/**
 * @param {object} deps
 * @param {object} deps.store     getJob, claimJob, getUser, completeJob, failJob
 * @param {{get(key), put(key, result)}} deps.reports
 * @param {({user, topic}) => Promise<{summary, report}>} deps.research
 * @param {{send(to, message)}} [deps.email]
 * @param {{send(to, message)}} [deps.whatsapp]
 * @param {number} [deps.maxAttempts=3]
 * @param {{userId: string, jobId: string, createdAt: string}} message
 * @returns {Promise<"done"|"skipped"|"failed">}
 */
export async function processJob(deps, message) {
  const { userId } = message;
  const sk = jobSk(message);
  const job = await deps.store.getJob(userId, sk);
  if (!job || job.status === "done" || job.status === "failed") return "skipped";
  if (!(await deps.store.claimJob(userId, sk))) return "skipped";
  const attempt = (job.attempts ?? 0) + 1;

  let result;
  const key = reportKey(userId, job.jobId);
  try {
    const user = await deps.store.getUser(userId);
    if (!user?.ai?.apiKeyEnc) throw new PermanentError("No AI provider configured.");
    result = await deps.reports.get(key);
    if (!result) {
      const { summary, report } = await deps.research({ user, topic: job.topic });
      result = { topic: job.topic, summary, report, createdAt: job.createdAt };
      await deps.reports.put(key, result);
    }
  } catch (e) {
    if (isPermanent(e) || attempt >= (deps.maxAttempts ?? 3)) {
      await deps.store.failJob(userId, sk, e.message);
      return "failed";
    }
    throw e; // let the queue retry
  }

  try {
    await deliver(deps, job, result);
  } catch (e) {
    if (!(e instanceof DeliveryError) || (!e.permanent && attempt < (deps.maxAttempts ?? 3))) throw e;
    // Research is done: keep it available by voice even if sending failed.
    await deps.store.completeJob(userId, sk, { summary: result.summary, reportKey: key, deliveryError: e.message });
    return "done";
  }
  await deps.store.completeJob(userId, sk, { summary: result.summary, reportKey: key });
  return "done";
}

async function deliver(deps, job, result) {
  if (job.channel === "voz") return;
  if (!job.destination) throw new DeliveryError("No destination for delivery.", { permanent: true });
  if (job.channel === "correo") {
    if (!deps.email) throw new DeliveryError("Email delivery is not configured.", { permanent: true });
    return deps.email.send(job.destination, renderEmail(result));
  }
  if (job.channel === "whatsapp") {
    if (!deps.whatsapp) throw new DeliveryError("WhatsApp delivery is not configured.", { permanent: true });
    return deps.whatsapp.send(job.destination, result);
  }
  throw new DeliveryError(`Unknown channel: ${job.channel}`, { permanent: true });
}
