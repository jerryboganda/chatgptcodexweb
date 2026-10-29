import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { longrunCopyFor, type LongrunCopy } from "./longrun-copy";
import type { Language, LauncherApi, LongrunJob, LongrunPhase } from "./types";
import "./longrun.css";

const POLL_MS = 4000;
const EFFORTS = ["medium", "high", "xhigh"] as const;
const EFFORT_LABELS: Record<(typeof EFFORTS)[number], string> = { medium: "Medium", high: "High", xhigh: "Extra High" };

function phaseLabel(copy: LongrunCopy, phase: LongrunPhase) {
  switch (phase) {
    case "running": return copy.phaseRunning;
    case "done": return copy.phaseDone;
    case "stopped": return copy.phaseStopped;
    case "restarting": return copy.phaseRestarting;
    case "waiting": return copy.phaseWaiting;
    default: return copy.phaseIdle;
  }
}

function acceptanceLabel(copy: LongrunCopy, value: LongrunJob["acceptance"]) {
  return value === "passing" ? copy.acceptancePassing : value === "failing" ? copy.acceptanceFailing : copy.acceptanceNotRun;
}

type FormState = {
  repo: string;
  task: string;
  verify: string;
  effort: (typeof EFFORTS)[number];
  maxHours: string;
  fullAccess: boolean;
  controller: boolean;
};

const EMPTY_FORM: FormState = { repo: "", task: "", verify: "", effort: "xhigh", maxHours: "24", fullAccess: false, controller: true };

export function LongrunSurface({
  api,
  language,
  setError,
}: {
  api: LauncherApi;
  language: Language;
  setError: (error: string | null) => void;
}) {
  const copy = longrunCopyFor(language);
  const [jobs, setJobs] = useState<LongrunJob[] | null>(null);
  const [available, setAvailable] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const result = await api.longrunList();
      if (!mounted.current) return;
      setJobs(result.jobs);
      setAvailable(result.available);
    } catch (error) {
      if (mounted.current) setError(`${copy.loadError} ${error instanceof Error ? error.message : ""}`.trim());
    }
  }, [api, copy.loadError, setError]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const unsubscribe = api.onLongrun((next) => { if (mounted.current) setJobs(next); });
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [api, refresh]);

  const run = async (key: string, action: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(key);
    try {
      const result = await action();
      if (!result.ok) setError(result.message || copy.actionError);
      else setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.actionError);
    } finally {
      if (mounted.current) setBusy(null);
      void refresh();
    }
  };

  const chooseFolder = async () => {
    const result = await api.longrunPickFolder();
    if (result.ok && result.path) setForm((current) => ({ ...current, repo: result.path as string }));
  };

  const submit = async (startNow: boolean) => {
    setFormError(null);
    setBusy("create");
    try {
      const created = await api.longrunCreate({
        repo: form.repo,
        task: form.task,
        verify: form.verify,
        effort: form.effort,
        maxHours: form.maxHours === "" ? undefined : Number(form.maxHours),
        sandbox: form.fullAccess ? "danger-full-access" : "workspace-write",
        controller: form.controller,
      });
      if (!created.ok) {
        setFormError(created.message || copy.actionError);
        return;
      }
      if (startNow) {
        const started = await api.longrunStart(created.job.id);
        if (!started.ok) setError(started.message || copy.actionError);
      }
      setForm(EMPTY_FORM);
      setFormOpen(false);
      void refresh();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : copy.actionError);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const showForm = formOpen || (jobs !== null && jobs.length === 0);

  return (
    <section aria-labelledby="longrun-title" className="content-surface longrun-surface">
      <div className="content-scroll longrun-scroll">
        <header className="surface-header longrun-header">
          <div>
            <h1 id="longrun-title">{copy.title}</h1>
            <p>{copy.subtitle}</p>
          </div>
          {!showForm ? (
            <button className="button-primary" onClick={() => setFormOpen(true)} type="button">
              <Icon name="plus" />
              <span>{copy.newTask}</span>
            </button>
          ) : null}
        </header>

        {!available ? <div className="longrun-banner" role="alert"><Icon name="alert" /><p>{copy.unavailable}</p></div> : null}

        {showForm ? (
          <form
            className="longrun-form"
            onSubmit={(event) => { event.preventDefault(); void submit(true); }}
          >
            <div className="longrun-field">
              <label htmlFor="longrun-repo">{copy.project}</label>
              <div className="longrun-folder">
                <span id="longrun-repo" title={form.repo}>{form.repo || copy.noFolder}</span>
                <button className="button-secondary" onClick={() => void chooseFolder()} type="button">{copy.choose}</button>
              </div>
            </div>
            <div className="longrun-field">
              <label htmlFor="longrun-task">{copy.taskLabel}</label>
              <textarea
                id="longrun-task"
                onChange={(event) => setForm({ ...form, task: event.target.value })}
                placeholder={copy.taskPlaceholder}
                rows={7}
                value={form.task}
              />
            </div>
            <div className="longrun-field">
              <label htmlFor="longrun-verify">{copy.verifyLabel}</label>
              <input
                id="longrun-verify"
                onChange={(event) => setForm({ ...form, verify: event.target.value })}
                placeholder={copy.verifyPlaceholder}
                spellCheck={false}
                type="text"
                value={form.verify}
              />
              <small>{copy.verifyHint}</small>
            </div>
            <div className="longrun-row">
              <div className="longrun-field">
                <label htmlFor="longrun-effort">{copy.effortLabel}</label>
                <select
                  id="longrun-effort"
                  onChange={(event) => setForm({ ...form, effort: event.target.value as FormState["effort"] })}
                  value={form.effort}
                >
                  {EFFORTS.map((effort) => <option key={effort} value={effort}>{EFFORT_LABELS[effort]}</option>)}
                </select>
              </div>
              <div className="longrun-field">
                <label htmlFor="longrun-hours">{copy.hoursLabel}</label>
                <input
                  id="longrun-hours"
                  inputMode="numeric"
                  max={168}
                  min={1}
                  onChange={(event) => setForm({ ...form, maxHours: event.target.value })}
                  type="number"
                  value={form.maxHours}
                />
              </div>
            </div>
            <label className="longrun-check">
              <input checked={form.controller} onChange={(event) => setForm({ ...form, controller: event.target.checked })} type="checkbox" />
              <span><strong>{copy.controller}</strong><small>{copy.controllerHint}</small></span>
            </label>
            <label className="longrun-check">
              <input checked={form.fullAccess} onChange={(event) => setForm({ ...form, fullAccess: event.target.checked })} type="checkbox" />
              <span><strong>{copy.fullAccess}</strong><small>{copy.fullAccessHint}</small></span>
            </label>
            {formError ? <div className="longrun-banner" role="alert"><Icon name="alert" /><p>{formError}</p></div> : null}
            <div className="longrun-actions">
              {jobs && jobs.length > 0 ? (
                <button className="button-secondary" onClick={() => { setFormOpen(false); setFormError(null); }} type="button">{copy.cancel}</button>
              ) : null}
              <button className="button-secondary" disabled={busy === "create"} onClick={() => void submit(false)} type="button">{copy.add}</button>
              <button className="button-primary" disabled={busy === "create"} type="submit">{busy === "create" ? copy.adding : copy.addAndStart}</button>
            </div>
          </form>
        ) : null}

        {jobs !== null && jobs.length === 0 ? (
          <div className="longrun-empty"><h2>{copy.emptyTitle}</h2><p>{copy.emptyBody}</p></div>
        ) : null}

        <ul className="longrun-list">
          {(jobs ?? []).map((job) => (
            <li className={`longrun-job is-${job.phase}`} key={job.id}>
              <div className="longrun-job-head">
                <div>
                  <h2>{job.title}</h2>
                  <p className="longrun-path" title={job.repo}>{job.repo}</p>
                </div>
                <span className={`longrun-phase is-${job.phase}`} role="status">{phaseLabel(copy, job.phase)}</span>
              </div>
              <dl className="longrun-stats">
                <div><dt>{copy.rounds}</dt><dd>{job.rounds}</dd></div>
                <div><dt>{copy.chats}</dt><dd>{job.chats}</dd></div>
                <div><dt>{copy.acceptance}</dt><dd>{acceptanceLabel(copy, job.acceptance)}</dd></div>
                <div><dt>{copy.effortLabel}</dt><dd>{EFFORT_LABELS[job.effort]}</dd></div>
              </dl>
              {job.activity ? <p className="longrun-activity">{job.activity}</p> : null}
              {job.phase === "stopped" && job.stopReason ? <p className="longrun-activity">{copy.reason}: {job.stopReason}</p> : null}
              {job.external ? <p className="longrun-activity">{copy.externalNote}</p> : null}
              {job.error ? <div className="longrun-banner" role="alert"><Icon name="alert" /><p>{job.error}</p></div> : null}
              <div className="longrun-actions">
                {job.phase === "running" || job.phase === "restarting" || job.phase === "waiting" ? (
                  <button className="button-secondary" disabled={busy === job.id} onClick={() => void run(job.id, () => api.longrunStop(job.id))} type="button">
                    <Icon name="pause" /><span>{copy.stop}</span>
                  </button>
                ) : null}
                {job.phase === "idle" ? (
                  <button className="button-primary" disabled={busy === job.id} onClick={() => void run(job.id, () => api.longrunStart(job.id))} type="button">
                    <span>{job.rounds > 0 ? copy.resume : copy.start}</span>
                  </button>
                ) : null}
                {job.phase === "stopped" ? (
                  // A stopped supervisor keeps its final state, so continuing means a new run that reuses the progress file and commits.
                  <button className="button-primary" disabled={busy === job.id} onClick={() => void run(job.id, () => api.longrunStart(job.id, { restart: true }))} type="button">
                    <span>{copy.resume}</span>
                  </button>
                ) : null}
                {job.hasReport ? (
                  <button className="button-secondary" onClick={() => void run(job.id, () => api.longrunOpen(job.id, "report"))} type="button">
                    <Icon name="external" /><span>{copy.openReport}</span>
                  </button>
                ) : null}
                <button className="button-secondary" onClick={() => void run(job.id, () => api.longrunOpen(job.id, "folder"))} type="button">
                  <Icon name="external" /><span>{copy.openFolder}</span>
                </button>
                {job.phase !== "running" && job.phase !== "restarting" ? (
                  <button
                    className="button-secondary"
                    disabled={busy === job.id}
                    onClick={() => { if (window.confirm(copy.confirmRemove)) void run(job.id, () => api.longrunRemove(job.id)); }}
                    type="button"
                  >
                    <span>{copy.remove}</span>
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        <p className="longrun-note">{copy.note}</p>
      </div>
    </section>
  );
}
