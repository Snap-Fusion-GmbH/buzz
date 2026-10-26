import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";

import {
  markCommunityOnboardingComplete,
  useCommunityOnboarding,
} from "@/features/onboarding/communityOnboarding";
import { retireSeededWelcomeChannels } from "@/features/onboarding/hooks";
import { useClaimInvite } from "@/features/onboarding/useClaimInvite";
import { CommunityChangeOverlay } from "@/features/communities/ui/CommunityChangeOverlay";
import { useAvatarPresentation } from "@/features/profile/avatarPresentationStore";
import { registerAvatarWhenReady } from "@/features/profile/avatarProfileSync";
import { profileQueryKey } from "@/features/profile/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import {
  parseEmojiAvatarDataUrl,
  ProfileAvatarEditor,
} from "@/features/profile/ui/ProfileAvatarEditor";
import { getProfile, updateProfile } from "@/shared/api/tauriProfiles";
import { getIdentity, importIdentity } from "@/shared/api/tauriIdentity";
import { relayClient } from "@/shared/api/relayClient";
import { cn } from "@/shared/lib/cn";
import { useSystemColorScheme } from "@/shared/theme/useSystemColorScheme";
import { Button } from "@/shared/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/shared/ui/dialog";
import { MembershipDenied } from "./MembershipDenied";
import { ONBOARDING_PRIMARY_CTA_CLASS } from "./OnboardingChrome";
import { OnboardingCard, useOnboardingCardLayout } from "./OnboardingCard";
import { OnboardingFooter } from "./OnboardingFooter";
import { OnboardingInput } from "./OnboardingInput";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";

function isRelayMembershipDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("You must be a relay member") ||
    error.message.includes("relay_membership_required") ||
    error.message.includes("restricted: not a relay member") ||
    error.message.includes("invalid: you are not a relay member")
  );
}

/** Fade duration for the "entering" curtain over the mounting app. */
const ENTERING_CURTAIN_FADE_MS = 500;
const NEUTRAL_EMOJI_PICKER_THEME_VARS = {
  "--buzz-emoji-picker-rgb-background":
    "var(--buzz-onboarding-emoji-picker-background)",
  "--buzz-emoji-picker-rgb-color": "var(--buzz-onboarding-emoji-picker-color)",
  "--buzz-emoji-picker-rgb-input": "var(--buzz-onboarding-emoji-picker-input)",
} as React.CSSProperties;

function AvatarCircle({
  avatarUrl,
  onClick,
  previewName,
  triggerRef,
}: {
  avatarUrl: string;
  onClick: () => void;
  previewName: string;
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  const cardLayout = useOnboardingCardLayout();
  const emojiAvatar = parseEmojiAvatarDataUrl(avatarUrl);
  const presentation = useAvatarPresentation(avatarUrl);
  const hasAvatar =
    avatarUrl.trim().length > 0 && presentation?.state !== "failed";

  return (
    <button
      aria-label={hasAvatar ? "Change your avatar" : "Add an avatar"}
      className="group block shrink-0 rounded-full"
      data-testid="community-avatar-open"
      onClick={onClick}
      ref={triggerRef}
      type="button"
    >
      {emojiAvatar ? (
        <span
          className={cn(
            "flex items-center justify-center overflow-hidden rounded-full shadow-xs",
            "size-28 text-4xl min-[44rem]:size-36 min-[44rem]:text-5xl",
          )}
          style={{ backgroundColor: emojiAvatar.color }}
        >
          {emojiAvatar.emoji}
        </span>
      ) : hasAvatar ? (
        <ProfileAvatar
          avatarUrl={avatarUrl}
          className={cn(
            "rounded-full",
            "size-28 text-3xl min-[44rem]:size-36 min-[44rem]:text-4xl",
          )}
          label={previewName}
          testId="community-avatar-circle"
        />
      ) : (
        <span
          className={cn(
            "flex items-center justify-center rounded-full text-[var(--buzz-onboarding-backup-ink)] transition-colors",
            cardLayout
              ? "size-28 border border-[#e2e2e2] bg-[#f9f9f9] group-hover:bg-[#f3f3f3] min-[44rem]:size-36"
              : "size-36 bg-white/30 group-hover:bg-white/40",
          )}
          data-testid="community-avatar-empty"
        >
          <Plus className="h-7 w-7" aria-hidden="true" />
        </span>
      )}
    </button>
  );
}

export function CommunityOnboardingFlow({
  onCancel,
  onConnect,
}: {
  onCancel: () => void;
  onConnect: () => void;
}) {
  const { transaction, update, clear } = useCommunityOnboarding();
  const queryClient = useQueryClient();
  const systemColorScheme = useSystemColorScheme();
  const [displayName, setDisplayName] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("");
  const [localAvatarPreviewUrl, setLocalAvatarPreviewUrl] = React.useState<
    string | null
  >(null);
  const [avatarSquishKey, setAvatarSquishKey] = React.useState(0);
  const [transitionDirection, setTransitionDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  const avatarPresentation = useAvatarPresentation(avatarUrl);
  const [isUploadingAvatar, setIsUploadingAvatar] = React.useState(false);
  const [isAvatarEditorOpen, setIsAvatarEditorOpen] = React.useState(false);
  const [animatedPreviewEl, setAnimatedPreviewEl] =
    React.useState<HTMLDivElement | null>(null);
  const [isAnimatedPreviewActive, setIsAnimatedPreviewActive] =
    React.useState(false);
  const [animatedPreviewCaption, setAnimatedPreviewCaption] = React.useState<
    string | null
  >(null);
  const [isPending, setIsPending] = React.useState(false);
  const finalizeInFlightRef = React.useRef(false);
  const checkedProfileTransactionRef = React.useRef<string | null>(null);
  const [deniedPubkey, setDeniedPubkey] = React.useState("");
  const [isMembershipDenied, setIsMembershipDenied] = React.useState(false);
  const [isCommunityChangeOpen, setIsCommunityChangeOpen] =
    React.useState(false);
  const [isCurtainFading, setIsCurtainFading] = React.useState(false);
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);
  const avatarTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  const avatarEditorContentRef = React.useRef<HTMLDivElement | null>(null);
  const [avatarEditorDialogHeight, setAvatarEditorDialogHeight] =
    React.useState<number | null>(null);
  const animateEmojiAvatarChange = React.useCallback(() => {
    setAvatarSquishKey((key) => key + 1);
  }, []);

  useClaimInvite();

  React.useEffect(() => {
    if (transaction?.stage === "connecting") onConnect();
  }, [onConnect, transaction?.stage]);

  // The app mounts under this curtain after onboarding; fade it once the frame
  // has had a chance to paint so the transition does not flash an empty shell.
  const isEnteringStage = transaction?.stage === "entering";
  React.useEffect(() => {
    if (!isEnteringStage) return;
    setIsCurtainFading(true);
    const timer = window.setTimeout(clear, ENTERING_CURTAIN_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [clear, isEnteringStage]);

  const retry = () =>
    update({
      stage: transaction?.inviteCode ? "claiming" : "connecting",
      error: undefined,
    });
  const relayUrl = transaction?.relayUrl;
  const finish = React.useCallback(async () => {
    if (!relayUrl) return;
    const identity = await getIdentity();
    markCommunityOnboardingComplete(identity.pubkey, relayUrl);
    clear();
  }, [clear, relayUrl]);
  const finalizeSetup = React.useCallback(
    async (force = false) => {
      if ((!force && finalizeInFlightRef.current) || !relayUrl) return;
      finalizeInFlightRef.current = true;
      setIsPending(true);
      update({ stage: "finalizing", error: undefined });
      try {
        const identity = await getIdentity();
        // Legacy welcome channels are retired once per identity/community.
        // A failure is surfaced and retried on the next start; it must not be
        // reported as setup success.
        const result = await retireSeededWelcomeChannels();
        markCommunityOnboardingComplete(identity.pubkey, relayUrl);
        if (!result.ok) {
          update({ error: result.reason });
        }
        // No channel is seeded any more, so the app lands on Home. Keep this
        // screen mounted briefly as a curtain; the entering effect clears it.
        update({
          stage: "entering",
          error: result.ok ? undefined : result.reason,
        });
      } catch (error) {
        update({
          error: error instanceof Error ? error.message : String(error),
        });
        finalizeInFlightRef.current = false;
        setIsPending(false);
      }
    },
    [relayUrl, update],
  );

  const isProfileStage = transaction?.stage === "profile";
  React.useEffect(() => {
    if (!isProfileStage || !transaction) return;
    if (checkedProfileTransactionRef.current === transaction.id) return;

    checkedProfileTransactionRef.current = transaction.id;
    void getProfile()
      .then((profile) => {
        if (profile.hasProfileEvent) {
          setTransitionDirection("forward");
          update({ stage: "finalizing", error: undefined }, transaction.id);
        }
      })
      .catch(() => {
        // Discovery is best-effort. Staying on the profile step preserves the
        // existing path when the relay cannot answer the lookup.
      });
  }, [isProfileStage, transaction, update]);

  React.useEffect(() => {
    if (transaction?.stage !== "finalizing" || transaction.error) return;
    void finalizeSetup();
  }, [finalizeSetup, transaction?.error, transaction?.stage]);

  React.useEffect(
    () => () => {
      finalizeInFlightRef.current = false;
    },
    [],
  );

  // Seed display name and avatar from the relay profile when the profile step
  // is shown. This covers the case where the skip raced or was bypassed (e.g.,
  // the user navigated Back). Only seeds fields that are still empty so that
  // any user edits are preserved.
  React.useEffect(() => {
    if (!isProfileStage) return;
    void getProfile()
      .then((profile) => {
        if (profile.displayName) {
          setDisplayName((prev) =>
            prev === "" ? (profile.displayName ?? "") : prev,
          );
        }
        if (profile.avatarUrl) {
          setAvatarUrl((prev) =>
            prev === "" ? (profile.avatarUrl ?? "") : prev,
          );
        }
      })
      .catch(() => {
        // Seeding is best-effort; silently ignore failures.
      });
  }, [isProfileStage]);

  React.useLayoutEffect(() => {
    if (isProfileStage && !isAvatarEditorOpen) {
      nameInputRef.current?.focus();
    }
  }, [isAvatarEditorOpen, isProfileStage]);

  React.useLayoutEffect(() => {
    if (!isAvatarEditorOpen) {
      setAvatarEditorDialogHeight(null);
      return;
    }

    const content = avatarEditorContentRef.current;
    if (!content) return;

    const updateHeight = () => {
      setAvatarEditorDialogHeight(content.getBoundingClientRect().height + 64);
    };
    updateHeight();

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(content);
    return () => resizeObserver.disconnect();
  }, [isAvatarEditorOpen]);

  if (!transaction) return null;

  if (isMembershipDenied) {
    return (
      <>
        <MembershipDenied
          activeRelayUrl={transaction.relayUrl}
          onBack={() => setIsMembershipDenied(false)}
          onChangeCommunity={() => setIsCommunityChangeOpen(true)}
          onImportKey={async (nsec) => {
            const identity = await importIdentity(nsec);
            relayClient.disconnect();
            queryClient.setQueryData(["identity"], identity);
            queryClient.removeQueries({ queryKey: profileQueryKey });
            setIsMembershipDenied(false);
            update({ stage: "connecting", error: undefined });
          }}
          onRetry={() => {
            setIsMembershipDenied(false);
            update({ stage: "connecting", error: undefined });
          }}
          pubkey={deniedPubkey}
        />
        {isCommunityChangeOpen ? (
          <CommunityChangeOverlay
            onClose={() => setIsCommunityChangeOpen(false)}
            onUpdated={(communityName, updatedRelayUrl) => {
              update({
                communityName,
                relayUrl: updatedRelayUrl,
                stage: "connecting",
                error: undefined,
              });
              setIsMembershipDenied(false);
            }}
          />
        ) : null}
      </>
    );
  }

  const saveProfile = async () => {
    if (!displayName.trim()) return;
    setIsPending(true);
    try {
      const candidateAvatarUrl = avatarUrl.trim();
      const presentationState = avatarPresentation?.state;
      const shouldSaveCandidate =
        candidateAvatarUrl.length > 0 &&
        presentationState !== "failed" &&
        presentationState !== "pending";

      const deferredAvatar =
        candidateAvatarUrl && presentationState && presentationState !== "ready"
          ? registerAvatarWhenReady({
              avatarUrl: candidateAvatarUrl,
              relayUrl: transaction.relayUrl,
            })
          : null;

      try {
        const profile = await updateProfile({
          displayName: displayName.trim(),
          avatarUrl: shouldSaveCandidate ? candidateAvatarUrl : undefined,
        });
        deferredAvatar?.release({
          expectedPubkey: profile.pubkey,
          expectedAvatarUrl: profile.avatarUrl,
        });
      } catch (error) {
        deferredAvatar?.cancel();
        throw error;
      }
      setTransitionDirection("forward");
      update({ stage: "finalizing", error: undefined });
    } catch (error) {
      if (isRelayMembershipDeniedError(error)) {
        try {
          const identity = await getIdentity();
          setDeniedPubkey(identity.pubkey);
        } catch {
          setDeniedPubkey("");
        }
        setIsMembershipDenied(true);
        return;
      }
      update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsPending(false);
    }
  };

  return (
    <div
      className={cn(
        isCurtainFading &&
          "pointer-events-none opacity-0 transition-opacity ease-out motion-reduce:transition-none",
      )}
      style={
        isCurtainFading
          ? { transitionDuration: `${ENTERING_CURTAIN_FADE_MS}ms` }
          : undefined
      }
    >
      <OnboardingCard
        allowWideContent={false}
        backAction={
          isProfileStage
            ? {
                disabled: isPending || isUploadingAvatar,
                onClick: onCancel,
                testId: "community-profile-back",
              }
            : undefined
        }
        current={isProfileStage ? 6 : 5}
        systemColorScheme={systemColorScheme}
        testId="community-onboarding-flow"
      >
        <OnboardingSlideTransition
          direction={transitionDirection}
          transitionKey={`community-${isProfileStage ? "profile" : "setup"}-${transitionDirection}`}
        >
          <div
            className={cn(
              "relative mx-auto w-full text-center",
              isProfileStage
                ? "flex max-w-[500px] flex-col items-center"
                : "flex min-h-full max-w-[560px] flex-col justify-center",
            )}
            data-testid="community-onboarding-body"
          >
            {transaction.stage === "claiming" ||
            transaction.stage === "connecting" ? (
              <>
                <Users className="mx-auto h-10 w-10" />
                <h1 className="mt-5 text-title font-normal">
                  Joining {transaction.communityName}
                </h1>
                <p className="mt-3 text-sm text-foreground/80">
                  {transaction.error ??
                    (transaction.stage === "claiming"
                      ? "Accepting your invite…"
                      : "Connecting securely…")}
                </p>
                <div className="mt-6 flex justify-center gap-3">
                  {transaction.error ? (
                    <Button className="rounded-full px-6" onClick={retry}>
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    className="rounded-full bg-foreground/10 px-5 hover:bg-foreground/15"
                    onClick={onCancel}
                    variant="ghost"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : isProfileStage ? (
              <>
                <div
                  className={cn(
                    "flex min-h-0 w-full flex-1 flex-col transition-[filter,opacity] duration-200 ease-out",
                    isAvatarEditorOpen &&
                      "pointer-events-none opacity-45 blur-[3px]",
                  )}
                  data-testid="community-profile-main"
                >
                  <div className="shrink-0">
                    <h1 className="text-title font-normal">
                      Build your profile
                    </h1>
                    <p className="mx-auto mt-3 max-w-[380px] text-sm leading-6 text-foreground/80">
                      Add a name and avatar. They’ll show up on your messages,
                      reactions, and agent handoffs.
                    </p>
                  </div>
                  <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center pt-6">
                    <AvatarCircle
                      avatarUrl={avatarUrl}
                      onClick={() => setIsAvatarEditorOpen(true)}
                      previewName={displayName.trim() || "Your profile"}
                      triggerRef={avatarTriggerRef}
                    />
                    <label
                      className="mt-4 block w-full max-w-[412px] text-left"
                      htmlFor="community-display-name"
                    >
                      <span className="mb-2 block pl-4 text-sm text-foreground">
                        Your username
                      </span>
                      <OnboardingInput
                        aria-label="Community username"
                        autoCapitalize="none"
                        autoComplete="username"
                        autoCorrect="off"
                        data-testid="community-profile-name-key"
                        disabled={isPending || isUploadingAvatar}
                        id="community-display-name"
                        onChange={(event) => setDisplayName(event.target.value)}
                        placeholder="Enter your username here"
                        ref={nameInputRef}
                        spellCheck={false}
                        type="text"
                        value={displayName}
                      />
                    </label>
                  </div>
                  {transaction.error ? (
                    <p className="mt-4 text-sm text-destructive">
                      {transaction.error}
                    </p>
                  ) : null}
                </div>
                <OnboardingFooter
                  className={cn(
                    "transition-[filter,opacity] duration-200 ease-out",
                    isAvatarEditorOpen &&
                      "pointer-events-none opacity-45 blur-[3px]",
                  )}
                >
                  <Button
                    className={`${ONBOARDING_PRIMARY_CTA_CLASS} w-20`}
                    data-testid="community-profile-next"
                    disabled={
                      !displayName.trim() || isPending || isUploadingAvatar
                    }
                    onClick={() => void saveProfile()}
                    type="button"
                  >
                    Next
                  </Button>
                </OnboardingFooter>
                <Dialog
                  onOpenChange={(open) => setIsAvatarEditorOpen(open)}
                  open={isAvatarEditorOpen}
                >
                  <DialogContent
                    className="buzz-onboarding-neutral-theme w-[min(calc(100vw-2rem),920px)] max-w-[920px] gap-0 overflow-hidden rounded-[18px] bg-[rgb(var(--buzz-onboarding-avatar-dialog-bg))] px-8 pb-6 pt-10 text-sm text-foreground shadow-[0_28px_90px_rgb(var(--buzz-onboarding-avatar-dialog-shadow)_/_0.28),0_8px_28px_rgb(var(--buzz-onboarding-avatar-dialog-shadow)_/_0.18)] transition-[height] duration-[250ms] ease-out"
                    closeButtonClassName="right-6 top-6 h-10 w-10 rounded-full bg-[rgb(var(--buzz-onboarding-avatar-action-bg))] text-[rgb(var(--buzz-onboarding-avatar-action-fg))] hover:bg-[rgb(var(--buzz-onboarding-avatar-action-bg)/0.9)] hover:text-[rgb(var(--buzz-onboarding-avatar-action-fg))]"
                    data-system-color-scheme="light"
                    data-testid="community-avatar-editor-key-frame"
                    onCloseAutoFocus={(event) => {
                      event.preventDefault();
                      avatarTriggerRef.current?.focus();
                    }}
                    overlayVariant="transparent"
                    style={
                      avatarEditorDialogHeight === null
                        ? undefined
                        : { height: avatarEditorDialogHeight }
                    }
                  >
                    <DialogTitle className="sr-only">
                      Edit your avatar
                    </DialogTitle>
                    <div
                      className="grid items-center gap-8 md:grid-cols-[240px_minmax(0,1fr)]"
                      ref={avatarEditorContentRef}
                    >
                      <div
                        className="flex min-h-[320px] flex-col items-center justify-center gap-3 px-6 py-8"
                        data-testid="community-avatar-live-preview-panel"
                      >
                        <div className="relative h-48 w-48">
                          <div
                            className="pointer-events-none absolute inset-0 z-10"
                            data-testid="community-avatar-animated-preview-slot"
                            ref={setAnimatedPreviewEl}
                          />
                          {isAnimatedPreviewActive
                            ? null
                            : (() => {
                                if (localAvatarPreviewUrl) {
                                  return (
                                    <ProfileAvatar
                                      avatarUrl={localAvatarPreviewUrl}
                                      className="h-full w-full rounded-full text-5xl"
                                      label={
                                        displayName.trim() || "Your profile"
                                      }
                                      testId="community-avatar-live-preview"
                                    />
                                  );
                                }
                                const emojiAvatar =
                                  parseEmojiAvatarDataUrl(avatarUrl);
                                return emojiAvatar ? (
                                  <div
                                    aria-label={`${displayName.trim() || "Your profile"} avatar`}
                                    className="flex h-full w-full items-center justify-center overflow-hidden rounded-full text-6xl shadow-xs"
                                    data-testid="community-avatar-live-preview"
                                    role="img"
                                    style={{
                                      backgroundColor: emojiAvatar.color,
                                    }}
                                  >
                                    <span
                                      className={cn(
                                        avatarSquishKey > 0 &&
                                          "buzz-avatar-squish",
                                      )}
                                      data-testid="community-avatar-live-preview-emoji"
                                      key={avatarSquishKey}
                                    >
                                      {emojiAvatar.emoji}
                                    </span>
                                  </div>
                                ) : (
                                  <ProfileAvatar
                                    avatarUrl={
                                      localAvatarPreviewUrl || avatarUrl || null
                                    }
                                    className="h-full w-full rounded-full text-5xl"
                                    label={displayName.trim() || "Your profile"}
                                    testId="community-avatar-live-preview"
                                  />
                                );
                              })()}
                        </div>
                        {animatedPreviewCaption ? (
                          <p className="text-center text-sm text-muted-foreground">
                            {animatedPreviewCaption}
                          </p>
                        ) : null}
                      </div>
                      <ProfileAvatarEditor
                        animatedPreviewContainer={animatedPreviewEl}
                        avatarUrl={avatarUrl}
                        disabled={isPending}
                        donePending={isUploadingAvatar}
                        emojiPickerTheme="auto"
                        emojiPickerThemeVars={NEUTRAL_EMOJI_PICKER_THEME_VARS}
                        onDone={() => setIsAvatarEditorOpen(false)}
                        onAnimatedPreviewActiveChange={
                          setIsAnimatedPreviewActive
                        }
                        onAnimatedPreviewCaptionChange={
                          setAnimatedPreviewCaption
                        }
                        onEmojiAvatarChange={animateEmojiAvatarChange}
                        onLocalPreviewChange={setLocalAvatarPreviewUrl}
                        onUploadingChange={setIsUploadingAvatar}
                        onUrlChange={setAvatarUrl}
                        presentation="onboarding-modal"
                        previewName={displayName.trim() || "Your profile"}
                        testIdPrefix="community-avatar"
                      />
                    </div>
                  </DialogContent>
                </Dialog>
              </>
            ) : (
              <>
                <Users className="mx-auto h-10 w-10" />
                <h1 className="mt-5 text-title font-normal">
                  Setting up your community
                </h1>
                <p className="mt-3 text-sm text-foreground/80">
                  {transaction.error ?? "Preparing your workspace…"}
                </p>
                {transaction.error ? (
                  <div className="mt-6 flex justify-center gap-3">
                    <Button
                      className="rounded-full px-6"
                      onClick={() => void finalizeSetup(true)}
                    >
                      Try again
                    </Button>
                    <Button
                      className="rounded-full bg-foreground/10 px-5 hover:bg-foreground/15"
                      onClick={() => void finish()}
                      variant="ghost"
                    >
                      Skip for now
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </OnboardingSlideTransition>
      </OnboardingCard>
    </div>
  );
}
