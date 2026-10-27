import 'dart:async';
import 'hosted_app_gate.dart';
import 'onboarding_app_entry.dart';
import 'shared/widgets/ios_navigation_metrics.dart';
import 'shared/community/paired_community_landing.dart';
import 'shared/community/community_loading_surface.dart';

import 'package:app_badge_plus/app_badge_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';

import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:uuid/uuid.dart';

import 'features/age_gate/age_restriction_page.dart';
import 'features/age_gate/age_signal_provider.dart';
import 'features/activity/activity_provider.dart';
import 'features/activity/inbox_local_state_provider.dart';
import 'features/activity/inbox_read_state.dart';
import 'features/channels/channel.dart';
import 'features/channels/channel_management_provider.dart';
import 'features/channels/channels_provider.dart';
import 'features/channels/unread_badge/unread_badge_provider.dart';
import 'features/home/home_page.dart';
import 'features/channels/me/me_page.dart';
import 'features/channels/me/me_unread_provider.dart';
import 'features/invites/invite_create_page.dart';
import 'features/invites/invite_join_provider.dart';
import 'features/invites/welcome_channels_retirement.dart';
import 'features/pairing/pairing_page.dart';
import 'features/pairing/pairing_provider.dart';
import 'features/channels/agent_activity/observer_subscription.dart';
import 'features/channels/channel_detail_page.dart';
import 'shared/widgets/app_route_observer.dart';
import 'features/profile/user_status_cache_provider.dart';
import 'features/profile/settings_profile_header.dart';
import 'features/profile/set_status_sheet.dart';
import 'features/profile/user_status_provider.dart';
import 'features/profile/profile_edit_page.dart';
import 'features/profile/profile_text_editor.dart';
import 'features/settings/settings_page.dart';
import 'features/settings/theme_picker_page.dart';
import 'shared/auth/auth.dart';
import 'shared/deeplink/pending_deep_link_provider.dart';
import 'shared/emoji/emoji_burst.dart';
import 'shared/relay/relay.dart';
import 'shared/read_state/read_state_provider.dart';
import 'shared/theme/theme.dart';
import 'shared/widgets/buzz_loading_indicator.dart';

const _starterChannelNamespace = '3ce33bea-8f09-5f1b-9c85-8a7d2659e6b0';

/// Names seeded as public starter channels by earlier releases. Matching on
/// the deterministic id as well keeps retirement from touching a channel the
/// community created on purpose under the same name.
const _retiredPublicStarterSlugs = ['general', 'welcome-everyone'];

/// The private per-user channel seeded by earlier releases.
const _retiredPrivateWelcomeName = 'Welcome';

final _inviteRelayConnectedProvider = FutureProvider.family<void, String>((
  ref,
  expectedRelayUrl,
) async {
  final currentConfig = ref.read(relayConfigProvider);
  if (currentConfig.baseUrl != expectedRelayUrl) {
    throw StateError('Active community changed before invite recovery');
  }
  if (ref.read(relaySessionProvider).status == SessionStatus.connected) return;

  final connected = Completer<void>();
  ref.listen(relaySessionProvider, (_, next) {
    if (connected.isCompleted) return;
    if (ref.read(relayConfigProvider).baseUrl != expectedRelayUrl) {
      connected.completeError(
        StateError('Active community changed during invite recovery'),
      );
    } else if (next.status == SessionStatus.connected) {
      connected.complete();
    }
  });
  await connected.future;
});

/// App-level bridge from invite joining to the channels feature.
class MobileInviteJoinRecovery implements InviteJoinRecovery {
  final Future<List<Channel>> Function() _loadChannels;
  final Future<List<ChannelMember>> Function(String channelId) _loadMembers;
  final Future<void> Function(String channelId) _leaveChannel;
  final Future<void> Function(String channelId) _deleteChannel;
  final String _relayHttpOrigin;
  final String? _currentPubkey;
  final bool Function() _isScopeCurrent;

  /// Creates recovery from channel-loading and membership operations.
  MobileInviteJoinRecovery({
    required Future<List<Channel>> Function() loadChannels,
    required Future<List<ChannelMember>> Function(String channelId) loadMembers,
    required Future<void> Function(String channelId) leaveChannel,
    required Future<void> Function(String channelId) deleteChannel,
    required String relayHttpOrigin,
    String? currentPubkey,
    bool Function()? isScopeCurrent,
  }) : _loadChannels = loadChannels,
       _loadMembers = loadMembers,
       _leaveChannel = leaveChannel,
       _deleteChannel = deleteChannel,
       _relayHttpOrigin = relayHttpOrigin,
       _currentPubkey = currentPubkey,
       _isScopeCurrent = isScopeCurrent ?? _alwaysCurrent;

  /// Retires the channels earlier releases seeded into every installation.
  ///
  /// Public starters are community-owned, so they are only left — rejoinable
  /// at any time and never destroyed for other members. The private per-user
  /// Welcome channel is deleted when this identity is its solo owner, and left
  /// otherwise.
  ///
  /// Idempotent: a retired channel is no longer a membership. All work is
  /// fenced to the community and identity that started it, and a partial
  /// failure propagates so the retry stays available instead of being
  /// reported as success.
  @override
  Future<void> retireWelcomeChannels() async {
    _ensureScopeCurrent();
    final channels = await _loadChannels();
    _ensureScopeCurrent();

    for (final slug in _retiredPublicStarterSlugs) {
      final channelId = desktopStarterChannelId(
        relayHttpOrigin: _relayHttpOrigin,
        slug: slug,
      );
      final channel = channels
          .where((candidate) => candidate.id == channelId && candidate.isMember)
          .firstOrNull;
      if (channel == null) continue;
      await _leaveChannel(channel.id);
      _ensureScopeCurrent();
    }

    for (final channel in channels) {
      if (!_isRetiredPrivateWelcome(channel)) continue;
      final members = await _loadMembers(channel.id);
      _ensureScopeCurrent();
      if (_mayDeletePrivateWelcome(
        channel,
        members,
        currentPubkey: _currentPubkey,
      )) {
        await _deleteChannel(channel.id);
      } else {
        await _leaveChannel(channel.id);
      }
      _ensureScopeCurrent();
    }
  }

  static bool _alwaysCurrent() => true;

  void _ensureScopeCurrent() {
    if (!_isScopeCurrent()) {
      throw StateError('Active community changed during invite recovery');
    }
  }
}

bool _isRetiredPrivateWelcome(Channel channel) =>
    channel.name.trim().toLowerCase() ==
        _retiredPrivateWelcomeName.toLowerCase() &&
    channel.isStream &&
    channel.isPrivate &&
    !channel.isArchived &&
    channel.isMember;

/// Deleting destroys the channel for everyone, so it is reserved for the
/// identity that owns a Welcome channel nobody else has joined. Everything
/// else is somebody else's channel: leaving is the most a client may do.
bool _mayDeletePrivateWelcome(
  Channel channel,
  List<ChannelMember> members, {
  String? currentPubkey,
}) {
  if (members.isEmpty) {
    // No roster means no proof of ownership; fall back to the creator bound
    // into the channel metadata.
    return currentPubkey != null &&
        channel.createdBy.toLowerCase() == currentPubkey.toLowerCase();
  }
  final actorIsOwner = members.any(
    (member) =>
        member.isOwner &&
        (currentPubkey == null ||
            member.pubkey.toLowerCase() == currentPubkey.toLowerCase()),
  );
  final humanMembers = members.where((member) => !member.isBot).length;
  return actorIsOwner && humanMembers <= 1;
}

/// Returns desktop's deterministic per-relay UUID for a public starter.
@visibleForTesting
String desktopStarterChannelId({
  required String relayHttpOrigin,
  required String slug,
}) {
  final scope = relayHttpOrigin.trim().replaceFirst(RegExp(r'/+$'), '');
  return const Uuid().v5(
    _starterChannelNamespace,
    'starter-channel:v1:$scope:$slug',
  );
}

/// Builds one fresh, identity-scoped invite recovery against the app container.
InviteJoinRecovery buildMobileInviteJoinRecovery(
  Ref ref,
  InviteJoinRecoveryScope scope,
) {
  final expectedConfig = ref.read(relayConfigProvider);
  if (expectedConfig.baseUrl != scope.relayHttpOrigin ||
      expectedConfig.nsec != scope.nsec) {
    throw StateError('Active community changed before invite recovery');
  }
  final channelActions = ref.read(channelActionsProvider);

  bool isScopeCurrent() {
    final currentConfig = ref.read(relayConfigProvider);
    return currentConfig.baseUrl == scope.relayHttpOrigin &&
        currentConfig.nsec == scope.nsec;
  }

  void ensureScopeCurrent() {
    if (!isScopeCurrent()) {
      throw StateError('Active community changed during invite recovery');
    }
  }

  return MobileInviteJoinRecovery(
    loadChannels: () async {
      ensureScopeCurrent();
      await ref.read(activeCommunityProvider.future);
      ensureScopeCurrent();
      await ref
          .read(_inviteRelayConnectedProvider(scope.relayHttpOrigin).future)
          .timeout(const Duration(seconds: 15));
      ensureScopeCurrent();
      final channels = await ref
          .read(channelsProvider.notifier)
          .fetchFresh(fetchDirectory: true);
      ensureScopeCurrent();
      return channels;
    },
    loadMembers: (channelId) async {
      ensureScopeCurrent();
      final members = await ref.read(channelMembersProvider(channelId).future);
      ensureScopeCurrent();
      return members;
    },
    leaveChannel: channelActions.leaveChannel,
    deleteChannel: channelActions.deleteChannel,
    relayHttpOrigin: scope.relayHttpOrigin,
    currentPubkey: ref.read(myPubkeyProvider),
    isScopeCurrent: isScopeCurrent,
  );
}

/// App-shell projection that joins Activity state for the Home navigation.
///
/// This belongs at the composition root because it deliberately aggregates
/// Activity feature providers for a sibling navigation surface.
final _unreadInboxItemCountProvider = Provider<int>((ref) {
  final readState = ref.watch(readStateProvider);
  if (!readState.isReady) return 0;

  final localState = ref.watch(inboxLocalStateProvider);
  final items = ref.watch(inboxItemsProvider);
  return items
      .where(
        (item) => !isInboxItemDone(
          item,
          markerOf: readState.effectiveTimestamp,
          localUnreadOverrides: localState.unreadIds,
          localDoneSet: localState.doneIds,
        ),
      )
      .length;
});

final _mobileRootNavigatorKey = GlobalKey<NavigatorState>();

class App extends HookConsumerWidget {
  const App({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ageSignalState = ref.watch(ageSignalProvider);
    ref.listen(ageSignalProvider, (_, next) {
      if (next == AgeSignalState.restricted) {
        ref.read(pairingProvider.notifier).reset();
      }
    });
    final communityTheme = ageSignalState != AgeSignalState.restricted
        ? ref.watch(communityThemeProvider)
        : defaultCommunityTheme;
    final themeMode = communityTheme.mode;
    final authState = ref.watch(authProvider);
    final pairedCommunity = ref.watch(pairedCommunityLandingProvider);

    useEffect(() {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        unawaited(ref.read(ageSignalProvider.notifier).request());
      });
      return null;
    }, const []);

    // Eagerly initialize websocket session and lifecycle observer when
    // authenticated. These providers connect and manage the websocket.
    var hasUnreadInbox = false;
    var hasUnreadSolo = false;
    if (ageSignalState != AgeSignalState.restricted &&
        authState.value?.status == AuthStatus.authenticated) {
      ref.watch(relaySessionProvider);
      // One-time removal of the channels earlier releases seeded. Best-effort:
      // a failure leaves the marker unset and the next start retries.
      ref.watch(welcomeChannelsRetirementProvider);
      // Listen, not watch: these publish often, and an App rebuild rebuilds
      // every route, including an open chat.
      ref.listen(observerRelayProvider, (_, _) {});
      ref.watch(appLifecycleProvider);
      ref.listen(userStatusCacheProvider, (_, _) {});
      hasUnreadInbox = ref.watch(_unreadInboxItemCountProvider) > 0;
      hasUnreadSolo = ref.watch(
        meUnreadChannelIdsProvider.select((ids) => ids.isNotEmpty),
      );
    }

    // Start listening for buzz:// links immediately (even pre-auth) so a
    // cold-start link survives until the authenticated UI can dispatch it.
    ref.watch(pendingDeepLinkProvider);

    void applyBadge(UnreadBadgeState state) {
      if (state.highPriorityCount > 0) {
        AppBadgePlus.updateBadge(state.highPriorityCount);
      } else if (state.generalUnreadCount > 0) {
        AppBadgePlus.updateBadge(1);
      } else {
        AppBadgePlus.updateBadge(0);
      }
    }

    useEffect(() {
      if (ageSignalState != AgeSignalState.restricted) {
        applyBadge(ref.read(unreadBadgeProvider));
      } else {
        AppBadgePlus.updateBadge(0);
      }
      return null;
    }, [ageSignalState]);
    if (ageSignalState != AgeSignalState.restricted) {
      ref.listen<UnreadBadgeState>(unreadBadgeProvider, (_, next) {
        applyBadge(next);
      });
    }

    return MaterialApp(
      navigatorKey: _mobileRootNavigatorKey,
      navigatorObservers: [appRouteObserver],
      title: 'Buzz',
      theme: mobileAppearanceTheme(Brightness.light, communityTheme.accent),
      darkTheme: mobileAppearanceTheme(Brightness.dark, communityTheme.accent),
      themeMode: themeMode,
      // Above the navigator, so an age restriction cannot be bypassed by a
      // route that was pushed while the store signal request was in flight.
      builder: (context, child) => switch (ageSignalState) {
        AgeSignalState.restricted => const AgeRestrictionPage(),
        _ => IosNavigationMetricsHost(
          child: AppMarkdownTheme(
            child: MobileHuddleShell(
              navigatorKey: _mobileRootNavigatorKey,
              child: EmojiBurstOverlay(
                child: Stack(
                  fit: StackFit.expand,
                  children: [
                    ExcludeSemantics(
                      excluding: pairedCommunity != null,
                      child: AbsorbPointer(
                        absorbing: pairedCommunity != null,
                        child: child ?? const SizedBox.shrink(),
                      ),
                    ),
                    // Cover the navigator while onboarding is removed and the
                    // destination installs the matching avatar-flight route.
                    if (pairedCommunity != null)
                      CommunityLoadingSurface(
                        name: pairedCommunity.name,
                        relayUrl: pairedCommunity.relayUrl,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      },
      home: authState.when(
        loading: () => const _SplashScreen(),
        error: (_, _) => const PairingPage(),
        data: (state) => switch (state.status) {
          AuthStatus.authenticated => HostedAppGate(
            authenticated: true,
            child: HomePage(
              mePageBuilder: (_, action) => MePage(newChatAction: action),
              settingsPageBuilder: _buildSettingsPage,
              communityInvitePageBuilder: (_) => const CommunityInvitePage(),
              communityAppearancePageBuilder: (_) => const ThemePickerPage(),
              hasUnreadInbox: hasUnreadInbox,
              hasUnreadSolo: hasUnreadSolo,
            ),
          ),
          _ => const HostedAppGate(
            authenticated: false,
            child: OnboardingAppEntry(),
          ),
        },
      ),
    );
  }
}

Widget _buildSettingsPage(BuildContext context) => const _SettingsPageContent();

class _SettingsPageContent extends ConsumerWidget {
  const _SettingsPageContent();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return SettingsPage(
      profileHeader: const SettingsProfileHeader(),
      profileEditPageBuilder: (_) =>
          const ProfileEditPage(startInPhotoEditor: true),
      onSetStatus: (context) => showSetStatusSheet(
        context,
        currentStatus: ref.read(userStatusProvider).asData?.value,
      ),
      onEditDisplayName: showProfileDisplayNameEditor,
      onEditProfileDescription: showProfileDescriptionEditor,
      identityRecoveryPageBuilder: (_) =>
          const PairingPage(addingCommunity: true, identityRecoveryOnly: true),
    );
  }
}

class _SplashScreen extends StatelessWidget {
  const _SplashScreen();

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: BuzzLoadingIndicator(size: 56, semanticLabel: 'Starting Buzz'),
      ),
    );
  }
}
