import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AccessConstraint,
  AccessContractDocument,
} from "../../../packages/contracts/src/index.js";
import {
  applyAccessibilityPreferences,
  loadAccessibilityPreferences,
  persistAccessibilityPreferences,
  type AccessibilityPreferences,
} from "./accessibility-preferences.js";
import {
  ApiError,
  apiRequest,
  jsonBody,
  type EvidenceItem,
  type RecoveryCase,
  type RecoveryOptionsResponse,
  type TripDetails,
  type TripSummary,
} from "./api.js";

type Screen = "trips" | "contract" | "disruption" | "recovery" | "privacy";
type NoticeTone = "info" | "warning" | "success" | "error";
type AnnouncementTarget = "general" | "recovery" | "provider-question";

const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Notice {
  message: string;
  tone: NoticeTone;
}

interface ProviderQuestionDraft {
  request_id: string;
  contract_version: number;
  constraint_id: string;
  asset_id: string;
  recipient: string;
  subject: string;
  body: string;
  expires_at: string;
  approval_hash: string;
  status: "draft";
  provenance: "fixture";
}

interface RecoveryPlan {
  plan_id: string;
  plan_sha256: string;
  expires_at: string;
}

interface RecoveryApproval {
  approval: { approval_id: string };
  plan: { state: string };
}

interface ExecutionReceipt {
  receipt: {
    receipt_id: string;
    status: string;
    provider: string;
    live_action: false;
  };
  plan: { state: string };
}

const NAV_ITEMS: Array<{ id: Screen; label: string; number: string }> = [
  { id: "trips", label: "Trips", number: "01" },
  { id: "contract", label: "Access Contract", number: "02" },
  { id: "disruption", label: "Disruption alert", number: "03" },
  { id: "recovery", label: "Recovery approval", number: "04" },
];

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return `${new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(date)} UTC`;
}

function formatMoney(amountMinor: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
  }).format(amountMinor / 100);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    active: "Monitoring active",
    degraded: "Review needed",
    violated: "Requirement changed",
    recovering: "Recovery in progress",
    closed: "Monitoring stopped",
    provider_confirmed: "Provider confirmed",
    documented: "Documented",
    unverified: "Not yet verified",
    unknown: "Unknown",
    satisfied: "Satisfied by current evidence",
    not_applicable: "Not applicable",
    detected: "Open case",
    completed: "Completed",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "violated"
      ? "danger"
      : status === "degraded" || status === "unverified" || status === "unknown"
        ? "warning"
        : status === "provider_confirmed" || status === "satisfied"
          ? "success"
          : "neutral";
  return (
    <span className={`status-badge status-${tone}`}>
      <span aria-hidden="true" className="status-glyph">
        {tone === "success"
          ? "✓"
          : tone === "danger"
            ? "!"
            : tone === "warning"
              ? "?"
              : "·"}
      </span>
      {statusLabel(status)}
    </span>
  );
}

function Icon({
  name,
}: {
  name: "shield" | "document" | "clock" | "link" | "arrow" | "lock";
}) {
  const paths: Record<typeof name, string> = {
    shield:
      "M12 2 4 5v6c0 5 3.4 9.1 8 11 4.6-1.9 8-6 8-11V5l-8-3Z M8.5 12l2.2 2.2 4.8-5",
    document: "M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z M12 7v5l3 2",
    link: "M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1 M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    lock: "M6 10h12v11H6z M8 10V7a4 4 0 1 1 8 0v3 M12 14v3",
  };
  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24" fill="none">
      <path
        d={paths[name]}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="error-banner" role="alert">
      <strong>Action not completed.</strong> {message}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("trips");
  const [accessibilityPreferences, setAccessibilityPreferences] =
    useState<AccessibilityPreferences>(loadAccessibilityPreferences);
  const [isAccessibilityPreferencesOpen, setIsAccessibilityPreferencesOpen] =
    useState(false);
  const [generalAnnouncement, setGeneralAnnouncement] = useState("");
  const [recoveryPlanAnnouncement, setRecoveryPlanAnnouncement] = useState("");
  const [providerQuestionAnnouncement, setProviderQuestionAnnouncement] =
    useState("");
  const accessibilityTriggerRef = useRef<HTMLButtonElement>(null);
  const accessibilityDialogRef = useRef<HTMLElement>(null);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [tripId, setTripId] = useState<string | null>(null);
  const [details, setDetails] = useState<TripDetails | null>(null);
  const [evidence, setEvidence] = useState<EvidenceItem[]>([]);
  const [recoveryOptions, setRecoveryOptions] =
    useState<RecoveryOptionsResponse | null>(null);
  const [selectedConstraintId, setSelectedConstraintId] = useState<
    string | null
  >(null);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [plan, setPlan] = useState<RecoveryPlan | null>(null);
  const [approval, setApproval] = useState<RecoveryApproval | null>(null);
  const [receipt, setReceipt] = useState<ExecutionReceipt | null>(null);
  const [questionDraft, setQuestionDraft] =
    useState<ProviderQuestionDraft | null>(null);
  const [questionRecipient, setQuestionRecipient] = useState(
    "accessibility@example.test",
  );
  const [approvalPhrase, setApprovalPhrase] = useState("");
  const [deletePhrase, setDeletePhrase] = useState("");
  const [pendingDeletionTaskId, setPendingDeletionTaskId] = useState<
    string | null
  >(null);
  const [callbackPreference, setCallbackPreference] = useState<
    "email" | "phone" | "none"
  >("email");
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(
    async (preferredTripId?: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await apiRequest<{ trips: TripSummary[] }>(
          "/api/v1/trips",
        );
        const nextTrips = response.trips;
        setTrips(nextTrips);
        const nextTripId =
          preferredTripId ??
          (tripId && nextTrips.some((item) => item.trip_id === tripId)
            ? tripId
            : nextTrips[0]?.trip_id);
        if (!nextTripId) {
          setTripId(null);
          setDetails(null);
          setEvidence([]);
          setRecoveryOptions(null);
          return;
        }
        setTripId(nextTripId);
        const nextDetails = await apiRequest<TripDetails>(
          `/api/v1/trips/${nextTripId}`,
        );
        setDetails(nextDetails);
        setSelectedConstraintId((current) =>
          current &&
          nextDetails.contract.constraints.some(
            (item) => item.constraint_id === current,
          )
            ? current
            : (nextDetails.contract.constraints[0]?.constraint_id ?? null),
        );
        const [evidenceResult, currentCase] = await Promise.all([
          apiRequest<{ items: EvidenceItem[] }>(
            `/api/v1/trips/${nextTripId}/evidence`,
          ),
          Promise.resolve(
            nextDetails.cases.find((item) => item.state === "detected") ?? null,
          ),
        ]);
        setEvidence(evidenceResult.items);
        if (currentCase) {
          setRecoveryOptions(
            await apiRequest<RecoveryOptionsResponse>(
              `/api/v1/cases/${currentCase.case_id}/options`,
            ),
          );
        } else {
          setRecoveryOptions(null);
        }
      } catch (cause) {
        setError(
          cause instanceof ApiError
            ? cause.message
            : "Could not reach the local fixture API.",
        );
      } finally {
        setIsLoading(false);
      }
    },
    [tripId],
  );

  useLayoutEffect(() => {
    applyAccessibilityPreferences(accessibilityPreferences);
    persistAccessibilityPreferences(accessibilityPreferences);
  }, [accessibilityPreferences]);

  useLayoutEffect(() => {
    if (!isAccessibilityPreferencesOpen) return;
    const dialog = accessibilityDialogRef.current;
    if (!dialog) return;

    const previouslyFocused = accessibilityTriggerRef.current;
    const focusableElements = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
      ).filter(
        (element) =>
          !element.hidden && element.getAttribute("aria-hidden") !== "true",
      );
    const initialFocus =
      dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
      focusableElements()[0];
    initialFocus?.focus();

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsAccessibilityPreferencesOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      document.removeEventListener("keydown", handleDialogKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isAccessibilityPreferencesOpen]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentTrip = trips.find((item) => item.trip_id === tripId) ?? null;
  const currentCase: RecoveryCase | null =
    details?.cases.find((item) => item.state === "detected") ?? null;
  const contract: AccessContractDocument | null = details?.contract ?? null;
  const selectedConstraint: AccessConstraint | null =
    contract?.constraints.find(
      (item) => item.constraint_id === selectedConstraintId,
    ) ?? null;
  const selectedEvidence = useMemo(() => {
    if (!selectedConstraint) return [];
    const ids = new Set(selectedConstraint.evidence_ids);
    return evidence.filter(
      (item) =>
        ids.has(item.evidence_id) &&
        selectedConstraint.applies_to.includes(item.asset_id),
    );
  }, [evidence, selectedConstraint]);
  const runAction = async <T,>(
    name: string,
    action: () => Promise<T>,
    success: (result: T) => string,
    announcementTarget: AnnouncementTarget = "general",
  ) => {
    setBusyAction(name);
    setError(null);
    setNotice(null);
    try {
      const result = await action();
      const message = success(result);
      setNotice({ message, tone: "success" });
      if (announcementTarget === "recovery") {
        setRecoveryPlanAnnouncement(message);
      } else if (announcementTarget === "provider-question") {
        setProviderQuestionAnnouncement(message);
      } else {
        setGeneralAnnouncement(message);
      }
      return result;
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : "Action failed.",
      );
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const exportContract = async () => {
    if (!tripId) return;
    const exported = await runAction(
      "export",
      () =>
        apiRequest<Record<string, unknown>>(`/api/v1/trips/${tripId}/export`),
      () =>
        "A portable contract export is ready. It contains contract history, not raw confirmation media.",
    );
    if (!exported) return;
    const blob = new Blob([JSON.stringify(exported, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `accesshold-trip-${tripId}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const draftQuestion = async () => {
    if (!tripId || !contract || !selectedConstraint) return;
    const assetId = selectedConstraint.applies_to[0];
    if (!assetId) return;
    const created = await runAction(
      "draft-question",
      () =>
        apiRequest<{ draft: ProviderQuestionDraft }>(
          `/api/v1/trips/${tripId}/provider-questions`,
          {
            method: "POST",
            body: jsonBody({
              expected_contract_version: contract.version,
              constraint_id: selectedConstraint.constraint_id,
              asset_id: assetId,
              recipient: questionRecipient,
              idempotency_key: `web-${crypto.randomUUID()}`,
            }),
          },
        ),
      () => "Question drafted for review. Nothing has been sent.",
      "provider-question",
    );
    if (created) {
      setQuestionDraft(created.draft);
      setProviderQuestionAnnouncement(
        "Provider question status: draft ready for review; nothing has been sent.",
      );
    }
  };

  const approveAndSendQuestion = async () => {
    if (!questionDraft) return;
    const result = await runAction(
      "send-question",
      () =>
        apiRequest<{
          receipt: { status: string; provider_confirmation_received: false };
        }>(`/api/v1/provider-questions/${questionDraft.request_id}/approve`, {
          method: "POST",
          body: jsonBody({
            expected_contract_version: questionDraft.contract_version,
            approval_hash: questionDraft.approval_hash,
          }),
        }),
      () =>
        "TEST PROVIDER message recorded. SES/provider confirmation has not been received.",
      "provider-question",
    );
    if (result) {
      setQuestionDraft(null);
      setProviderQuestionAnnouncement(
        "Provider question status: sent to the test provider; no provider confirmation has been received.",
      );
    }
  };

  const selectOption = async () => {
    if (!currentCase || !recoveryOptions || !selectedOptionId) return;
    const result = await runAction(
      "select-option",
      () =>
        apiRequest<{
          plan_id: string;
          plan_sha256: string;
          plan: RecoveryPlan;
        }>(`/api/v1/cases/${currentCase.case_id}/options`, {
          method: "POST",
          body: jsonBody({
            option_id: selectedOptionId,
            expected_version: recoveryOptions.option_set_version,
          }),
        }),
      () => "A pending plan is ready. It has not been approved or executed.",
      "recovery",
    );
    if (result) {
      setPlan({
        plan_id: result.plan_id,
        plan_sha256: result.plan_sha256,
        expires_at: result.plan.expires_at,
      });
      setApproval(null);
      setReceipt(null);
      setApprovalPhrase("");
    }
  };

  const approvePlan = async () => {
    if (!plan) return;
    const result = await runAction(
      "approve-plan",
      () =>
        apiRequest<RecoveryApproval>(
          `/api/v1/plans/${plan.plan_id}/approvals`,
          {
            method: "POST",
            body: jsonBody({
              plan_sha256: plan.plan_sha256,
              approval_phrase: approvalPhrase,
            }),
          },
        ),
      () => "Exact plan approved. No provider action has been executed yet.",
      "recovery",
    );
    if (result) setApproval(result);
  };

  const executePlan = async () => {
    if (!plan || !approval) return;
    const result = await runAction(
      "execute-plan",
      () =>
        apiRequest<ExecutionReceipt>(`/api/v1/plans/${plan.plan_id}/execute`, {
          method: "POST",
          body: jsonBody({ plan_sha256: plan.plan_sha256 }),
        }),
      () =>
        "TEST PROVIDER action recorded. Waiting for an independently imported confirmation.",
      "recovery",
    );
    if (result) setReceipt(result);
  };

  const requestHandoff = async () => {
    if (!currentCase) return;
    await runAction(
      "handoff",
      () =>
        apiRequest<{ status: string }>(
          `/api/v1/cases/${currentCase.case_id}/handoff`,
          {
            method: "POST",
            body: jsonBody({ callback_preference: callbackPreference }),
          },
        ),
      () =>
        "Handoff packet prepared locally. It has not been sent to a person.",
    );
  };

  const stopMonitoring = async () => {
    if (!tripId || !contract) return;
    const result = await runAction(
      "stop-monitoring",
      () =>
        apiRequest(`/api/v1/trips/${tripId}/revoke-monitoring`, {
          method: "POST",
          body: jsonBody({ expected_version: contract.version }),
        }),
      () => "Monitoring stopped. Stored contract data has not been deleted.",
    );
    if (result) await refresh(tripId);
  };

  const requestDeletion = async () => {
    if (!tripId || !contract) return;
    const result = await runAction(
      "delete-trip",
      () =>
        apiRequest<{ task: { task_id: string; state: string } }>(
          `/api/v1/trips/${tripId}`,
          {
            method: "DELETE",
            body: jsonBody({
              expected_contract_version: contract.version,
              confirmation_phrase: deletePhrase,
            }),
          },
        ),
      () =>
        "Deletion task queued. The local fixture worker must run the cleanup steps.",
    );
    if (result) {
      setDeletePhrase("");
      setNotice({
        tone: "warning",
        message: `Deletion task ${result.task.task_id} is queued. Data is not deleted until all artifact scopes are erased.`,
      });
      setPendingDeletionTaskId(result.task.task_id);
    }
  };

  const runDeletion = async () => {
    if (!pendingDeletionTaskId) return;
    const result = await runAction(
      "run-deletion",
      () =>
        apiRequest<{ task: { state: string; deleted_scopes: string[] } }>(
          `/api/v1/tasks/${pendingDeletionTaskId}/run`,
          { method: "POST", body: jsonBody({}) },
        ),
      (value) =>
        `Fixture cleanup ${value.task.state}; ${value.task.deleted_scopes.length} artifact scopes recorded.`,
    );
    if (result?.task.state === "completed") {
      setPendingDeletionTaskId(null);
      setScreen("trips");
      await refresh();
    }
  };

  const extendRetention = async () => {
    if (!tripId || !contract) return;
    await runAction(
      "extend-retention",
      () =>
        apiRequest(`/api/v1/trips/${tripId}/retention-extension`, {
          method: "POST",
          body: jsonBody({
            expected_contract_version: contract.version,
            retain_until: "2027-01-01T00:00:00.000Z",
          }),
        }),
      () => "Retention extension recorded for this local fixture.",
    );
  };

  const saveDraftCorrection = async (nextText: string) => {
    if (!tripId || !contract || !selectedConstraint) return;
    const corrected = structuredClone(contract);
    const target = corrected.constraints.find(
      (item) => item.constraint_id === selectedConstraint.constraint_id,
    );
    if (!target) return;
    target.traveler_text = nextText;
    const result = await runAction(
      "correct-draft",
      () =>
        apiRequest(`/api/v1/trips/${tripId}/draft`, {
          method: "PATCH",
          body: jsonBody({
            expected_version: contract.version,
            document: corrected,
          }),
        }),
      () =>
        "Draft correction saved as a new contract version. Monitoring has not started.",
    );
    if (result) await refresh(tripId);
  };

  const goTo = (nextScreen: Screen) => {
    setScreen(nextScreen);
    setNotice(null);
    setError(null);
  };

  if (isLoading && !contract) {
    return (
      <div className="app-shell">
        <div className="loading-state" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true">
            AH
          </span>
          <p>Loading trip evidence…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <a
        className="skip-link"
        aria-hidden={isAccessibilityPreferencesOpen}
        inert={isAccessibilityPreferencesOpen}
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main");
          main?.focus();
          main?.scrollIntoView?.({ block: "start" });
          window.history.replaceState(null, "", "#main");
        }}
      >
        Skip to main content
      </a>
      <header
        className="global-header"
        aria-hidden={isAccessibilityPreferencesOpen}
        inert={isAccessibilityPreferencesOpen}
      >
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="shield" />
          </span>
          <span className="brand-name">AccessHold</span>
          <span className="brand-divider" aria-hidden="true" />
          <span className="brand-context">Travel evidence desk</span>
        </div>
        <div className="header-tools">
          <span className="environment-label">
            <span className="environment-dot" /> TEST PROVIDER · LOCAL FIXTURE
          </span>
          <button
            className="icon-button privacy-button"
            type="button"
            onClick={() => goTo("privacy")}
            aria-label="Open privacy controls"
          >
            <Icon name="lock" />
            <span>Privacy</span>
          </button>
          <button
            className="avatar-button"
            type="button"
            onClick={() => goTo("privacy")}
            aria-label="Open account and privacy settings"
          >
            AR
          </button>
          <button
            ref={accessibilityTriggerRef}
            className="icon-button accessibility-button"
            type="button"
            onClick={() => setIsAccessibilityPreferencesOpen(true)}
            aria-label="Accessibility preferences"
            aria-haspopup="dialog"
            aria-expanded={isAccessibilityPreferencesOpen}
          >
            <span aria-hidden="true">Aa</span>
            <span>Accessibility</span>
          </button>
        </div>
      </header>

      <div
        className="workspace"
        aria-hidden={isAccessibilityPreferencesOpen}
        inert={isAccessibilityPreferencesOpen}
      >
        <aside className="sidebar" aria-label="Workspace sidebar">
          <p className="nav-caption">WORKSPACE</p>
          <nav className="primary-nav" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`nav-item ${screen === item.id ? "selected" : ""}`}
                aria-current={screen === item.id ? "page" : undefined}
                onClick={() => goTo(item.id)}
              >
                <span className="nav-number">{item.number}</span>
                <span>{item.label}</span>
                {item.id === "disruption" && currentTrip?.open_case_count ? (
                  <span
                    className="nav-count"
                    aria-label={`${currentTrip.open_case_count} open case`}
                  >
                    {currentTrip.open_case_count}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="secure-note">
              <Icon name="lock" />
              <div>
                <strong>Private workspace</strong>
                <span>Owner-only fixture session</span>
              </div>
            </div>
            <p className="sidebar-version">Build 0.1 · Fixture data only</p>
          </div>
        </aside>

        <main id="main" className="main-content" tabIndex={-1}>
          {error ? <ErrorMessage message={error} /> : null}
          {notice ? (
            <div
              className={`notice-banner notice-${notice.tone}`}
              aria-live="off"
            >
              {notice.message}
            </div>
          ) : null}

          {!contract || !currentTrip ? (
            <EmptyTrips onRefresh={() => void refresh()} />
          ) : (
            <>
              <div className="page-heading-row">
                <div>
                  <p className="eyebrow">
                    TRIP REVIEW <span className="eyebrow-separator">/</span>{" "}
                    {currentTrip.title.toUpperCase()}
                  </p>
                  <h1>{pageTitle(screen)}</h1>
                  <p className="page-subtitle">
                    A clear record of what changed, what is evidenced, and what
                    remains uncertain.
                  </p>
                </div>
                <div className="heading-status">
                  <StatusBadge status={contract.status} />
                  <span className="as-of">
                    As of{" "}
                    {formatDateTime(details?.as_of ?? currentTrip.starts_at)}
                  </span>
                </div>
              </div>

              {screen === "trips" ? (
                <TripsScreen
                  trip={currentTrip}
                  contract={contract}
                  currentCase={currentCase}
                  onOpenContract={() => goTo("contract")}
                  onOpenDisruption={() => goTo("disruption")}
                />
              ) : null}
              {screen === "contract" ? (
                <ContractScreen
                  contract={contract}
                  selectedConstraint={selectedConstraint}
                  selectedConstraintId={selectedConstraintId}
                  evidence={selectedEvidence}
                  questionRecipient={questionRecipient}
                  setQuestionRecipient={setQuestionRecipient}
                  questionDraft={questionDraft}
                  busyAction={busyAction}
                  onSelectConstraint={setSelectedConstraintId}
                  onExport={() => void exportContract()}
                  onDraftQuestion={() => void draftQuestion()}
                  onApproveQuestion={() => void approveAndSendQuestion()}
                  onEditDraft={(text) => void saveDraftCorrection(text)}
                />
              ) : null}
              {screen === "disruption" ? (
                <DisruptionScreen
                  contract={contract}
                  currentCase={currentCase}
                  selectedConstraint={selectedConstraint}
                  evidence={selectedEvidence}
                  callbackPreference={callbackPreference}
                  setCallbackPreference={setCallbackPreference}
                  busyAction={busyAction}
                  onOpenRecovery={() => goTo("recovery")}
                  onRequestHandoff={() => void requestHandoff()}
                  onOpenContract={() => goTo("contract")}
                />
              ) : null}
              {screen === "recovery" ? (
                <RecoveryScreen
                  currentCase={currentCase}
                  recoveryOptions={recoveryOptions}
                  selectedOptionId={selectedOptionId}
                  setSelectedOptionId={setSelectedOptionId}
                  plan={plan}
                  approval={approval}
                  receipt={receipt}
                  approvalPhrase={approvalPhrase}
                  setApprovalPhrase={setApprovalPhrase}
                  callbackPreference={callbackPreference}
                  setCallbackPreference={setCallbackPreference}
                  busyAction={busyAction}
                  onSelectOption={() => void selectOption()}
                  onApprove={() => void approvePlan()}
                  onExecute={() => void executePlan()}
                  onRequestHandoff={() => void requestHandoff()}
                  onBackToAlert={() => goTo("disruption")}
                />
              ) : null}
              {screen === "privacy" ? (
                <PrivacyScreen
                  trip={currentTrip}
                  contract={contract}
                  deletePhrase={deletePhrase}
                  setDeletePhrase={setDeletePhrase}
                  pendingDeletionTaskId={pendingDeletionTaskId}
                  busyAction={busyAction}
                  onStopMonitoring={() => void stopMonitoring()}
                  onExtendRetention={() => void extendRetention()}
                  onRequestDeletion={() => void requestDeletion()}
                  onRunDeletion={() => void runDeletion()}
                  onExport={() => void exportContract()}
                />
              ) : null}
            </>
          )}
        </main>
      </div>

      <footer
        className="global-footer"
        aria-hidden={isAccessibilityPreferencesOpen}
        inert={isAccessibilityPreferencesOpen}
      >
        <span>
          AccessHold provides evidence and workflow state — not an accessibility
          guarantee.
        </span>
        <span className="footer-code">LOCAL FIXTURE · NOT A LIVE BOOKING</span>
      </footer>

      {isAccessibilityPreferencesOpen ? (
        <div
          className="accessibility-modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsAccessibilityPreferencesOpen(false);
            }
          }}
        >
          <section
            id="accessibility-preferences-dialog"
            ref={accessibilityDialogRef}
            className="accessibility-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="accessibility-dialog-title"
            aria-describedby="accessibility-dialog-description"
            tabIndex={-1}
          >
            <div className="accessibility-dialog-heading">
              <div>
                <p className="eyebrow">DISPLAY AND MOTION</p>
                <h2 id="accessibility-dialog-title">
                  Accessibility preferences
                </h2>
              </div>
            </div>
            <p id="accessibility-dialog-description" className="muted-copy">
              These choices are saved on this device and can be changed at any
              time.
            </p>
            <div className="accessibility-settings">
              <label className="accessibility-setting-row">
                <span className="accessibility-setting-copy">
                  <strong>High contrast mode</strong>
                  <span>
                    Use a black background, bright text, and clear outlines.
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="High contrast mode"
                  data-dialog-initial-focus="true"
                  checked={accessibilityPreferences.highContrast}
                  onChange={(event) =>
                    setAccessibilityPreferences((current) => ({
                      ...current,
                      highContrast: event.target.checked,
                    }))
                  }
                />
              </label>
              <label className="accessibility-setting-row">
                <span className="accessibility-setting-copy">
                  <strong>Reduce motion</strong>
                  <span>Minimize transitions and smooth scrolling.</span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Reduce motion"
                  checked={accessibilityPreferences.reduceMotion}
                  onChange={(event) =>
                    setAccessibilityPreferences((current) => ({
                      ...current,
                      reduceMotion: event.target.checked,
                    }))
                  }
                />
              </label>
            </div>
            <div className="accessibility-dialog-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={() => setIsAccessibilityPreferencesOpen(false)}
              >
                Close accessibility preferences
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        className="sr-only"
        role="status"
        aria-label="General status updates"
        aria-live="polite"
        aria-atomic="true"
      >
        {generalAnnouncement}
      </div>
      <div
        className="sr-only"
        role="status"
        aria-label="Recovery plan updates"
        aria-live="polite"
        aria-atomic="true"
      >
        {recoveryPlanAnnouncement}
      </div>
      <div
        className="sr-only"
        role="status"
        aria-label="Provider question status"
        aria-live="polite"
        aria-atomic="true"
      >
        {providerQuestionAnnouncement}
      </div>
    </div>
  );
}

function pageTitle(screen: Screen): string {
  const titles: Record<Screen, string> = {
    trips: "Trips and change queue",
    contract: "Review your Access Contract",
    disruption: "A room detail needs review",
    recovery: "Review recovery options",
    privacy: "Privacy and trip data",
  };
  return titles[screen];
}

function TripRail({
  trip,
  selected = true,
}: {
  trip: TripSummary;
  selected?: boolean;
}) {
  return (
    <section
      className={`trip-card ${selected ? "trip-card-selected" : ""}`}
      aria-label="Trip summary"
    >
      <div className="trip-card-topline">
        <span className="trip-type">
          <span className="trip-type-mark">STAY</span> HOTEL STAY
        </span>
        <StatusBadge status={trip.status} />
      </div>
      <h2>{trip.title}</h2>
      <p className="route-line">
        <span className="route-dot" /> Amsterdam, Netherlands{" "}
        <span className="route-detail">Hotel stay</span>
      </p>
      <div className="trip-dates">
        <div>
          <span>ARRIVAL</span>
          <strong>{formatDateTime(trip.starts_at)}</strong>
        </div>
        <div>
          <span>DEPARTURE</span>
          <strong>{formatDateTime(trip.ends_at)}</strong>
        </div>
      </div>
      <div className="trip-card-meta">
        <span>Contract v{trip.contract_version}</span>
        <span>
          {trip.open_case_count} open case
          {trip.open_case_count === 1 ? "" : "s"}
        </span>
      </div>
    </section>
  );
}

function TripsScreen({
  trip,
  contract,
  currentCase,
  onOpenContract,
  onOpenDisruption,
}: {
  trip: TripSummary;
  contract: AccessContractDocument;
  currentCase: RecoveryCase | null;
  onOpenContract: () => void;
  onOpenDisruption: () => void;
}) {
  const changed = contract.assets[0];
  return (
    <div className="trip-layout">
      <div className="trip-rail-column">
        <div className="section-kicker">
          <span>YOUR TRIP</span>
          <span>01 / 01</span>
        </div>
        <TripRail trip={trip} />
        <div className="sync-card">
          <span className="sync-icon">
            <Icon name="clock" />
          </span>
          <div>
            <strong>Last checked</strong>
            <span>24 Oct 2026 · 10:00 UTC</span>
          </div>
          <span className="sync-live">FIXTURE</span>
        </div>
      </div>
      <div className="trip-work-column">
        <div className="section-kicker">
          <span>CHANGE QUEUE</span>
          <span>{currentCase ? "1 OPEN" : "NO OPEN CASES"}</span>
        </div>
        {currentCase ? (
          <section className="change-card" aria-labelledby="change-heading">
            <div className="change-card-top">
              <span className="change-icon">
                <Icon name="link" />
              </span>
              <span className="change-time">24 Oct · 09:45 UTC</span>
            </div>
            <div className="change-tag">ROOM CONFIGURATION UPDATED</div>
            <h2 id="change-heading">One hard requirement needs review.</h2>
            <p className="change-description">
              The current room record no longer shows the roll-in shower feature
              required by your contract. The evidence is unverified.
            </p>
            <div className="change-detail-grid">
              <div>
                <span>CHANGED ASSET</span>
                <strong>
                  {changed?.provider ?? "Hotel room"} · booked room
                </strong>
              </div>
              <div>
                <span>AFFECTED REQUIREMENT</span>
                <strong>
                  {contract.constraints.find((item) =>
                    currentCase.constraint_ids.includes(item.constraint_id),
                  )?.traveler_text ?? "Hard requirement"}
                </strong>
              </div>
            </div>
            <div className="change-card-actions">
              <button
                className="button button-primary"
                type="button"
                onClick={onOpenDisruption}
              >
                Review disruption <Icon name="arrow" />
              </button>
              <button
                className="button button-text"
                type="button"
                onClick={onOpenContract}
              >
                Open contract
              </button>
            </div>
            <p className="fixture-note">
              <span className="fixture-label">TEST PROVIDER</span> Fixture
              change only. No live travel status was polled.
            </p>
          </section>
        ) : (
          <div className="empty-panel">
            <h2>No open changes</h2>
            <p>There are no changes requiring review for this trip.</p>
          </div>
        )}
        <div className="trip-next-steps">
          <div>
            <span className="step-number">1</span>
            <p>
              <strong>Understand the change</strong>
              <span>Review the affected asset and evidence.</span>
            </p>
          </div>
          <div>
            <span className="step-number">2</span>
            <p>
              <strong>Compare options</strong>
              <span>Unknown details remain visible.</span>
            </p>
          </div>
          <div>
            <span className="step-number">3</span>
            <p>
              <strong>Choose what happens</strong>
              <span>Nothing is booked without your approval.</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidencePanel({
  items,
  selectedConstraint,
}: {
  items: EvidenceItem[];
  selectedConstraint: AccessConstraint | null;
}) {
  return (
    <section className="evidence-panel" aria-labelledby="evidence-heading">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">EVIDENCE COVERAGE</p>
          <h2 id="evidence-heading">What supports this requirement?</h2>
        </div>
        <Icon name="document" />
      </div>
      {selectedConstraint ? (
        <p className="evidence-requirement">
          “{selectedConstraint.traveler_text}”
        </p>
      ) : null}
      {items.length ? (
        items.map((item) => (
          <article className="evidence-item" key={item.evidence_id}>
            <div className="evidence-item-heading">
              <StatusBadge status={item.verification_level} />
              <span className="evidence-source">
                {item.source_type.replaceAll("_", " ")}
              </span>
            </div>
            <div className="evidence-time-grid">
              <div>
                <span>OBSERVED</span>
                <strong>{formatDateTime(item.observed_at)}</strong>
              </div>
              <div>
                <span>EXPIRES</span>
                <strong>
                  {item.expires_at
                    ? formatDateTime(item.expires_at)
                    : "No expiry recorded"}
                </strong>
              </div>
            </div>
            <ul className="feature-list">
              {item.features.map((feature) => (
                <li key={feature.key}>
                  <span>{feature.key.replaceAll(".", " · ")}</span>
                  <strong>
                    {feature.value === null
                      ? "Unknown"
                      : typeof feature.value === "boolean"
                        ? feature.value
                          ? "Yes"
                          : "No"
                        : typeof feature.value === "number"
                          ? `${feature.value}${feature.unit ? ` ${feature.unit}` : ""}`
                          : "Text withheld"}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="evidence-disclaimer">
              Structured fixture detail only. Raw source content is not
              embedded.
            </p>
          </article>
        ))
      ) : (
        <p className="muted-copy">
          No evidence is attached to this requirement yet.
        </p>
      )}
    </section>
  );
}

function ContractScreen({
  contract,
  selectedConstraint,
  selectedConstraintId,
  evidence,
  questionRecipient,
  setQuestionRecipient,
  questionDraft,
  busyAction,
  onSelectConstraint,
  onExport,
  onDraftQuestion,
  onApproveQuestion,
  onEditDraft,
}: {
  contract: AccessContractDocument;
  selectedConstraint: AccessConstraint | null;
  selectedConstraintId: string | null;
  evidence: EvidenceItem[];
  questionRecipient: string;
  setQuestionRecipient: (value: string) => void;
  questionDraft: ProviderQuestionDraft | null;
  busyAction: string | null;
  onSelectConstraint: (value: string) => void;
  onExport: () => void;
  onDraftQuestion: () => void;
  onApproveQuestion: () => void;
  onEditDraft: (text: string) => void;
}) {
  const [editedText, setEditedText] = useState(
    selectedConstraint?.traveler_text ?? "",
  );
  useEffect(
    () => setEditedText(selectedConstraint?.traveler_text ?? ""),
    [selectedConstraintId, selectedConstraint?.traveler_text],
  );
  const sorted = [...contract.constraints].sort((left, right) =>
    left.priority === right.priority ? 0 : left.priority === "hard" ? -1 : 1,
  );
  return (
    <div className="contract-grid">
      <section className="contract-list-panel">
        <div className="panel-topline">
          <div>
            <p className="eyebrow">CONTRACT VERSION {contract.version}</p>
            <h2>Requirements</h2>
          </div>
          <StatusBadge status={contract.status} />
        </div>
        <p className="muted-copy">
          Review the exact requirement, asset scope, and current verification
          state.
        </p>
        <div
          className="constraint-list"
          role="list"
          aria-label="Access requirements"
        >
          {sorted.map((constraint, index) => (
            <div
              key={constraint.constraint_id}
              className="constraint-list-item"
              role="listitem"
            >
              <button
                className={`constraint-row ${selectedConstraintId === constraint.constraint_id ? "constraint-row-selected" : ""}`}
                type="button"
                onClick={() => onSelectConstraint(constraint.constraint_id)}
                aria-pressed={selectedConstraintId === constraint.constraint_id}
              >
                <span className="constraint-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="constraint-copy">
                  <span
                    className={`priority-label priority-${constraint.priority}`}
                  >
                    {constraint.priority === "hard"
                      ? "HARD REQUIREMENT"
                      : "PREFERENCE"}
                  </span>
                  <strong>{constraint.traveler_text}</strong>
                  <span>
                    {constraint.applies_to.length} applicable asset
                    {constraint.applies_to.length === 1 ? "" : "s"}
                  </span>
                </span>
                <StatusBadge status={constraint.status} />
              </button>
            </div>
          ))}
        </div>
        <div className="contract-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onExport}
          >
            <Icon name="document" /> Export portable contract
          </button>
          <span>JSON · contract history included</span>
        </div>
      </section>
      <div className="contract-detail-column">
        <section className="selected-requirement-card">
          <div className="detail-title-row">
            <span className="detail-icon">
              <Icon name="shield" />
            </span>
            <div>
              <p className="eyebrow">SELECTED REQUIREMENT</p>
              <h2>
                {selectedConstraint?.predicate.feature.replaceAll(".", " · ") ??
                  "Select a requirement"}
              </h2>
            </div>
          </div>
          {selectedConstraint ? (
            <>
              <dl className="definition-grid">
                <div>
                  <dt>Priority</dt>
                  <dd>
                    {selectedConstraint.priority === "hard"
                      ? "Must be met to remain suitable"
                      : "Preference, never treated as mandatory"}
                  </dd>
                </div>
                <div>
                  <dt>Predicate</dt>
                  <dd className="mono">
                    {selectedConstraint.predicate.operator}{" "}
                    {String(selectedConstraint.predicate.value)}
                    {selectedConstraint.predicate.unit
                      ? ` ${selectedConstraint.predicate.unit}`
                      : ""}
                  </dd>
                </div>
                <div>
                  <dt>Applies to</dt>
                  <dd>{selectedConstraint.applies_to.join(", ")}</dd>
                </div>
              </dl>
              {contract.status === "draft" ? (
                <form
                  className="draft-correction"
                  onSubmit={(event) => {
                    event.preventDefault();
                    onEditDraft(editedText);
                  }}
                >
                  <label htmlFor="draft-constraint-text">
                    Correct traveler wording
                  </label>
                  <textarea
                    id="draft-constraint-text"
                    value={editedText}
                    maxLength={500}
                    onChange={(event) => setEditedText(event.target.value)}
                  />
                  <button
                    className="button button-secondary"
                    type="submit"
                    disabled={busyAction === "correct-draft"}
                  >
                    Save correction as new draft version
                  </button>
                </form>
              ) : (
                <p className="read-only-note">
                  <Icon name="lock" /> This reviewed version is read-only.
                  Corrections are available on a draft before activation.
                </p>
              )}
            </>
          ) : null}
        </section>
        <EvidencePanel
          items={evidence}
          selectedConstraint={selectedConstraint}
        />
        <section className="question-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">PROVIDER VERIFICATION</p>
              <h2>Ask what remains unknown</h2>
            </div>
            <span className="draft-stamp">DRAFT → APPROVE → SEND</span>
          </div>
          <p className="muted-copy">
            The traveler wording stays private. Review the exact recipient and
            message before any request is sent.
          </p>
          {!questionDraft ? (
            <div className="question-composer">
              <label htmlFor="provider-recipient">
                Provider email recipient
              </label>
              <div className="input-row">
                <input
                  id="provider-recipient"
                  type="email"
                  value={questionRecipient}
                  onChange={(event) => setQuestionRecipient(event.target.value)}
                  required
                />
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={onDraftQuestion}
                  disabled={
                    !selectedConstraint || busyAction === "draft-question"
                  }
                >
                  {busyAction === "draft-question"
                    ? "Drafting…"
                    : "Draft question"}
                </button>
              </div>
              <p className="form-help">
                The recipient is shown in full before approval. Use only an
                address the traveler is comfortable contacting.
              </p>
            </div>
          ) : (
            <div className="draft-review">
              <div className="draft-topline">
                <StatusBadge status="unverified" />
                <span>Expires {formatDateTime(questionDraft.expires_at)}</span>
              </div>
              <p>
                <strong>To:</strong> {questionDraft.recipient}
              </p>
              <p>
                <strong>Subject:</strong> {questionDraft.subject}
              </p>
              <pre>{questionDraft.body}</pre>
              <div className="hash-line">
                <span>APPROVAL HASH</span>
                <code title={questionDraft.approval_hash}>
                  {questionDraft.approval_hash}
                </code>
              </div>
              <button
                className="button button-accent"
                type="button"
                onClick={onApproveQuestion}
                disabled={busyAction === "send-question"}
              >
                Approve this exact message and send
              </button>
              <p className="form-help">
                A fixture receipt means message recorded only; it does not mean
                the provider confirmed any feature.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function DisruptionScreen({
  contract,
  currentCase,
  selectedConstraint,
  evidence,
  callbackPreference,
  setCallbackPreference,
  busyAction,
  onOpenRecovery,
  onRequestHandoff,
  onOpenContract,
}: {
  contract: AccessContractDocument;
  currentCase: RecoveryCase | null;
  selectedConstraint: AccessConstraint | null;
  evidence: EvidenceItem[];
  callbackPreference: "email" | "phone" | "none";
  setCallbackPreference: (value: "email" | "phone" | "none") => void;
  busyAction: string | null;
  onOpenRecovery: () => void;
  onRequestHandoff: () => void;
  onOpenContract: () => void;
}) {
  const changedAsset = contract.assets[0];
  const changedEvidence = evidence[0];
  return (
    <div className="disruption-layout">
      <div className="disruption-main-column">
        <section className="change-banner" role="status" aria-live="polite">
          <div className="change-banner-symbol">
            <Icon name="link" />
          </div>
          <div className="change-banner-copy">
            <span className="change-tag">
              ROOM CONFIGURATION UPDATED · 24 OCT 2026, 09:45 UTC
            </span>
            <h2>One hard requirement needs review.</h2>
            <p>
              We found a change in structured fixture evidence. Unknown does not
              mean satisfied.
            </p>
          </div>
          <StatusBadge status="violated" />
        </section>
        <section className="affected-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">AFFECTED BOOKING</p>
              <h2>
                {changedAsset?.provider ?? "Hotel provider"} · booked room
              </h2>
            </div>
            <span className="asset-tag">HOTEL ROOM</span>
          </div>
          <div className="comparison-row">
            <div>
              <span>PREVIOUS RECORD</span>
              <strong>Roll-in shower listed</strong>
              <StatusBadge status="provider_confirmed" />
            </div>
            <span className="comparison-arrow" aria-label="changed to">
              →
            </span>
            <div className="comparison-new">
              <span>CURRENT RECORD</span>
              <strong>Roll-in shower not listed</strong>
              <StatusBadge status="unverified" />
            </div>
          </div>
          <p className="small-muted">
            Asset reference is hidden from the summary. Current record is not a
            live provider confirmation.
          </p>
        </section>
        <section className="affected-requirement-card">
          <div className="requirement-heading">
            <div>
              <span className="priority-label priority-hard">
                HARD REQUIREMENT
              </span>
              <h2>
                {selectedConstraint?.traveler_text ??
                  "A hard access requirement needs review."}
              </h2>
            </div>
            <StatusBadge status="violated" />
          </div>
          <div className="requirement-explanation">
            <span className="explanation-mark">!</span>
            <p>
              The current room feature no longer matches the saved requirement.
              A replacement detail has not been independently confirmed.
            </p>
          </div>
          <button type="button" className="text-link" onClick={onOpenContract}>
            Review contract wording and evidence <Icon name="arrow" />
          </button>
        </section>
        <section className="unknown-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">STILL UNKNOWN</p>
              <h2>What is not confirmed</h2>
            </div>
            <span className="unknown-icon">?</span>
          </div>
          <ul>
            <li>Whether the booked room has a step-free shower entry.</li>
            <li>
              Whether any alternative room preserves the same access features.
            </li>
            <li>Whether the provider has received or answered a request.</li>
          </ul>
          <p className="small-muted">
            No assumption is made from a property description or fixture
            response.
          </p>
        </section>
      </div>
      <aside className="disruption-side-column">
        <EvidencePanel
          items={changedEvidence ? [changedEvidence] : evidence}
          selectedConstraint={selectedConstraint}
        />
        <section className="next-action-card">
          <p className="eyebrow">NEXT STEP</p>
          <h2>Compare before deciding.</h2>
          <p>
            Options show cost, terms, expiry, and every unresolved detail.
            Nothing is selected for you.
          </p>
          <button
            className="button button-primary button-full"
            type="button"
            onClick={onOpenRecovery}
          >
            Review recovery options <Icon name="arrow" />
          </button>
        </section>
        <section className="handoff-mini-card">
          <p className="eyebrow">PREFER A PERSON?</p>
          <h2>Prepare a handoff packet</h2>
          <label htmlFor="callback-preference">Callback preference</label>
          <select
            id="callback-preference"
            value={callbackPreference}
            onChange={(event) =>
              setCallbackPreference(
                event.target.value as "email" | "phone" | "none",
              )
            }
          >
            <option value="email">Email follow-up</option>
            <option value="phone">Phone follow-up</option>
            <option value="none">No callback preference</option>
          </select>
          <button
            className="button button-secondary button-full"
            type="button"
            onClick={onRequestHandoff}
            disabled={busyAction === "handoff"}
          >
            {busyAction === "handoff" ? "Preparing…" : "Prepare human handoff"}
          </button>
          <p className="form-help">
            Creates a local fixture packet. It is not sent.
          </p>
        </section>
      </aside>
      {currentCase ? (
        <p className="case-code">
          CASE {currentCase.case_id} · VERSION {currentCase.version} · OPENED{" "}
          {formatDateTime(currentCase.opened_at)}
        </p>
      ) : null}
    </div>
  );
}

function RecoveryScreen({
  currentCase,
  recoveryOptions,
  selectedOptionId,
  setSelectedOptionId,
  plan,
  approval,
  receipt,
  approvalPhrase,
  setApprovalPhrase,
  callbackPreference,
  setCallbackPreference,
  busyAction,
  onSelectOption,
  onApprove,
  onExecute,
  onRequestHandoff,
  onBackToAlert,
}: {
  currentCase: RecoveryCase | null;
  recoveryOptions: RecoveryOptionsResponse | null;
  selectedOptionId: string | null;
  setSelectedOptionId: (value: string | null) => void;
  plan: RecoveryPlan | null;
  approval: RecoveryApproval | null;
  receipt: ExecutionReceipt | null;
  approvalPhrase: string;
  setApprovalPhrase: (value: string) => void;
  callbackPreference: "email" | "phone" | "none";
  setCallbackPreference: (value: "email" | "phone" | "none") => void;
  busyAction: string | null;
  onSelectOption: () => void;
  onApprove: () => void;
  onExecute: () => void;
  onRequestHandoff: () => void;
  onBackToAlert: () => void;
}) {
  return (
    <div className="recovery-page">
      <div className="recovery-summary-strip">
        <div>
          <span className="summary-icon">!</span>
          <div>
            <strong>Room configuration changed</strong>
            <span>
              One hard requirement needs review · Case{" "}
              {currentCase?.case_id ?? "unavailable"}
            </span>
          </div>
        </div>
        <button type="button" className="text-link" onClick={onBackToAlert}>
          Back to disruption details <Icon name="arrow" />
        </button>
      </div>
      {!currentCase || !recoveryOptions ? (
        <div className="empty-panel">
          <h2>No open recovery case</h2>
          <p>There are no recovery options to review for this trip.</p>
        </div>
      ) : (
        <>
          <div className="recovery-content-grid">
            <section className="option-section">
              <div className="section-header">
                <div>
                  <p className="eyebrow">
                    AVAILABLE OPTIONS · VERSION{" "}
                    {recoveryOptions.option_set_version}
                  </p>
                  <h2>Compare what could happen</h2>
                </div>
                <span className="not-preselected">NO OPTION PRESELECTED</span>
              </div>
              <div
                className="option-list"
                role="radiogroup"
                aria-label="Recovery options"
              >
                {recoveryOptions.options.map((option) => (
                  <label
                    key={option.option_id}
                    className={`option-card ${selectedOptionId === option.option_id ? "option-card-selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name="recovery-option"
                      value={option.option_id}
                      checked={selectedOptionId === option.option_id}
                      onChange={() => setSelectedOptionId(option.option_id)}
                    />
                    <div className="option-card-body">
                      <div className="option-card-head">
                        <div>
                          <span className="option-overline">
                            TEST PROVIDER · SANDBOX OPTION
                          </span>
                          <h3>{option.summary}</h3>
                        </div>
                        <strong className="option-cost">
                          {formatMoney(option.amount_minor, option.currency)}
                        </strong>
                      </div>
                      <div className="option-meta-grid">
                        <div>
                          <span>HARD REQUIREMENTS</span>
                          <strong>One detail remains unknown</strong>
                        </div>
                        <div>
                          <span>EXPIRES</span>
                          <strong>{formatDateTime(option.expires_at)}</strong>
                        </div>
                        <div>
                          <span>ACTION</span>
                          <strong>Sandbox rebook · no live booking</strong>
                        </div>
                      </div>
                      <div className="option-terms">
                        <strong>Terms</strong>
                        <p>{option.terms}</p>
                      </div>
                      <div className="unknown-inline">
                        <strong>Unknown</strong>
                        <ul>
                          {option.unknowns.map((unknown) => (
                            <li key={unknown}>{unknown}</li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </label>
                ))}
                <div className="no-action-card">
                  <span className="no-action-mark">—</span>
                  <div>
                    <strong>{recoveryOptions.no_action.summary}</strong>
                    <span>
                      No external action. Current requirement still needs
                      resolution.
                    </span>
                  </div>
                </div>
              </div>
              <div className="option-actions">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={!selectedOptionId || busyAction === "select-option"}
                  onClick={onSelectOption}
                >
                  {busyAction === "select-option"
                    ? "Preparing plan…"
                    : "Review selected recovery"}{" "}
                  <Icon name="arrow" />
                </button>
                <p>Selection creates a plan for review only.</p>
              </div>
            </section>
            <aside className="approval-sidebar">
              <section className="approval-card">
                <div className="approval-card-heading">
                  <span className="approval-lock">
                    <Icon name="lock" />
                  </span>
                  <div>
                    <p className="eyebrow">APPROVAL</p>
                    <h2>Nothing happens until you approve.</h2>
                  </div>
                </div>
                {!plan ? (
                  <div className="approval-empty">
                    <span className="approval-step-number">01</span>
                    <p>
                      Select an option to create a plan. The exact price, terms,
                      and expiry will be shown here first.
                    </p>
                  </div>
                ) : (
                  <div className="approval-review">
                    <div className="approval-plan-head">
                      <span className="status-dot pending" />{" "}
                      <strong>Pending your approval</strong>
                    </div>
                    <dl className="approval-details">
                      <div>
                        <dt>Plan hash</dt>
                        <dd>
                          <code title={plan.plan_sha256}>
                            {plan.plan_sha256.slice(0, 16)}…
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>Expires</dt>
                        <dd>{formatDateTime(plan.expires_at)}</dd>
                      </div>
                      <div>
                        <dt>Action</dt>
                        <dd>TEST PROVIDER sandbox rebook only</dd>
                      </div>
                    </dl>
                    {!approval ? (
                      <div className="phrase-confirmation">
                        <label htmlFor="approval-phrase">
                          Type <strong>APPROVE RECOVERY</strong> to approve this
                          exact plan
                        </label>
                        <input
                          id="approval-phrase"
                          value={approvalPhrase}
                          onChange={(event) =>
                            setApprovalPhrase(event.target.value)
                          }
                          autoComplete="off"
                        />
                        <button
                          className="button button-accent button-full"
                          type="button"
                          disabled={
                            approvalPhrase !== "APPROVE RECOVERY" ||
                            busyAction === "approve-plan"
                          }
                          onClick={onApprove}
                        >
                          {busyAction === "approve-plan"
                            ? "Approving…"
                            : "Approve exact plan"}
                        </button>
                      </div>
                    ) : (
                      <div className="approval-complete" role="status">
                        <span className="status-dot pending" />
                        <div>
                          <strong>Approval recorded</strong>
                          <span>
                            Approval ID {approval.approval.approval_id}
                          </span>
                        </div>
                      </div>
                    )}
                    {approval && !receipt ? (
                      <div className="execute-box">
                        <p>
                          Approval is bound to the hash above. Execute the TEST
                          PROVIDER fixture action separately.
                        </p>
                        <button
                          className="button button-primary button-full"
                          type="button"
                          onClick={onExecute}
                          disabled={busyAction === "execute-plan"}
                        >
                          {busyAction === "execute-plan"
                            ? "Recording fixture action…"
                            : "Execute fixture action"}
                        </button>
                      </div>
                    ) : null}
                    {receipt ? (
                      <div className="receipt-box" role="status">
                        <span className="status-dot pending" />
                        <div>
                          <strong>Waiting for provider confirmation</strong>
                          <span>
                            {receipt.receipt.provider} ·{" "}
                            {receipt.receipt.status}
                          </span>
                          <span>Receipt {receipt.receipt.receipt_id}</span>
                        </div>
                        <p>
                          Acceptance is not confirmation. No live booking was
                          changed.
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
              <section className="policy-note">
                <Icon name="shield" />
                <p>
                  <strong>Approval scope</strong>
                  <span>
                    One plan hash · one TEST PROVIDER action · no live payment
                    or booking.
                  </span>
                </p>
              </section>
              <section className="handoff-mini-card">
                <p className="eyebrow">HUMAN SUPPORT</p>
                <h2>Prefer not to choose alone?</h2>
                <label htmlFor="recovery-callback">Callback preference</label>
                <select
                  id="recovery-callback"
                  value={callbackPreference}
                  onChange={(event) =>
                    setCallbackPreference(
                      event.target.value as "email" | "phone" | "none",
                    )
                  }
                >
                  <option value="email">Email follow-up</option>
                  <option value="phone">Phone follow-up</option>
                  <option value="none">No callback preference</option>
                </select>
                <button
                  className="button button-secondary button-full"
                  type="button"
                  onClick={onRequestHandoff}
                  disabled={busyAction === "handoff"}
                >
                  Prepare handoff packet
                </button>
                <p className="form-help">
                  This local demo does not contact a human.
                </p>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}

function PrivacyScreen({
  trip,
  contract,
  deletePhrase,
  setDeletePhrase,
  pendingDeletionTaskId,
  busyAction,
  onStopMonitoring,
  onExtendRetention,
  onRequestDeletion,
  onRunDeletion,
  onExport,
}: {
  trip: TripSummary;
  contract: AccessContractDocument;
  deletePhrase: string;
  setDeletePhrase: (value: string) => void;
  pendingDeletionTaskId: string | null;
  busyAction: string | null;
  onStopMonitoring: () => void;
  onExtendRetention: () => void;
  onRequestDeletion: () => void;
  onRunDeletion: () => void;
  onExport: () => void;
}) {
  return (
    <div className="privacy-page">
      <section className="privacy-intro">
        <span className="privacy-shield">
          <Icon name="lock" />
        </span>
        <div>
          <p className="eyebrow">OWNER CONTROLS</p>
          <h2>Your trip data stays under your control.</h2>
          <p>
            Export, stop future monitoring, extend retention, or start deletion.
            Each action is explicit.
          </p>
        </div>
      </section>
      <div className="privacy-grid">
        <section className="privacy-control-card">
          <span className="control-index">01</span>
          <div>
            <h3>Export your trip</h3>
            <p>
              Download a portable JSON copy of contract versions. Raw
              confirmation media is not part of this fixture export.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={onExport}
            >
              Download contract export
            </button>
          </div>
        </section>
        <section className="privacy-control-card">
          <span className="control-index">02</span>
          <div>
            <h3>Stop monitoring</h3>
            <p>
              Prevents future collection for this trip. Stopping monitoring does
              not delete stored contract data.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={onStopMonitoring}
              disabled={
                !trip.monitoring_authorized || busyAction === "stop-monitoring"
              }
            >
              {trip.monitoring_authorized
                ? "Stop future monitoring"
                : "Monitoring already stopped"}
            </button>
          </div>
        </section>
        <section className="privacy-control-card">
          <span className="control-index">03</span>
          <div>
            <h3>Extend retention</h3>
            <p>
              Keep derived contract data beyond the default 30 days after the
              trip ends.
            </p>
            <button
              type="button"
              className="button button-secondary"
              onClick={onExtendRetention}
              disabled={busyAction === "extend-retention"}
            >
              Extend until 1 Jan 2027
            </button>
          </div>
        </section>
        <section className="privacy-control-card danger-control">
          <span className="control-index">04</span>
          <div>
            <h3>Delete this trip</h3>
            <p>
              Deletion stops monitoring, then erases contract history and
              configured artifact scopes. This local fixture worker is not
              durable across process restart.
            </p>
            <label htmlFor="delete-confirmation">
              Type <strong>DELETE MY TRIP</strong> to start
            </label>
            <input
              id="delete-confirmation"
              value={deletePhrase}
              onChange={(event) => setDeletePhrase(event.target.value)}
              autoComplete="off"
            />
            <button
              type="button"
              className="button button-danger"
              onClick={onRequestDeletion}
              disabled={
                deletePhrase !== "DELETE MY TRIP" ||
                busyAction === "delete-trip" ||
                contract.status === "closed"
              }
            >
              {busyAction === "delete-trip" ? "Starting…" : "Start deletion"}
            </button>
            {pendingDeletionTaskId ? (
              <div className="pending-task">
                <p>
                  Task {pendingDeletionTaskId} is queued. The contract stays
                  until every required artifact scope is erased.
                </p>
                <button
                  className="button button-danger"
                  type="button"
                  onClick={onRunDeletion}
                  disabled={busyAction === "run-deletion"}
                >
                  {busyAction === "run-deletion"
                    ? "Deleting fixture data…"
                    : "Run local fixture cleanup"}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <div className="retention-note">
        <Icon name="clock" />
        <p>
          <strong>Default retention</strong>
          <span>
            Raw confirmation and email: 30 days. Derived contract: trip deletion
            or 30 days after trip end, unless you extend retention. Current
            contract version: {contract.version}.
          </span>
        </p>
      </div>
    </div>
  );
}

function EmptyTrips({ onRefresh }: { onRefresh: () => void }) {
  return (
    <section className="empty-trips">
      <span className="empty-mark">
        <Icon name="document" />
      </span>
      <p className="eyebrow">NO TRIP DATA</p>
      <h1>Your trips will appear here.</h1>
      <p>
        This local dashboard uses only synthetic fixture data. Connect an
        approved booking through the configured import flow to continue.
      </p>
      <button
        className="button button-secondary"
        type="button"
        onClick={onRefresh}
      >
        Check again
      </button>
    </section>
  );
}
