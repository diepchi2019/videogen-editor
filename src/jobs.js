// In-memory registry of long-running jobs (exports, transcriptions).
import { uid } from './model.js';

const jobs = new Map();
export const getJob = (id) => jobs.get(id);
export const listJobs = () => [...jobs.values()];

export function createJob(kind, extra = {}) {
  const job = { id: uid('job'), kind, status: 'running', progress: 0, error: null, startedAt: Date.now(), ...extra };
  jobs.set(job.id, job);
  // Keep the registry small.
  if (jobs.size > 200) for (const [id, j] of jobs) { if (j.status !== 'running') { jobs.delete(id); break; } }
  return job;
}

export function finishJob(job, error, result) {
  Object.assign(job, error ? { status: 'error', error } : { status: 'done', progress: 1, result }, { finishedAt: Date.now() });
}

// Resolves with the job once it is no longer running, or after timeoutMs (job still running).
export function waitJob(id, timeoutMs = 600000) {
  const until = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      const j = jobs.get(id);
      if (!j || j.status !== 'running' || Date.now() > until) return resolve(j);
      setTimeout(check, 250);
    };
    check();
  });
}
