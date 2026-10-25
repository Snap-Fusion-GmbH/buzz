import 'dart:async';

import 'package:hooks_riverpod/hooks_riverpod.dart';

import '../../shared/relay/relay.dart';
import '../../shared/theme/theme.dart';
import 'invite_join_provider.dart';

/// Per-identity and per-community marker for the one-time welcome-channel
/// retirement. The key matches desktop's so a shared identity does not repeat
/// the work across clients.
String welcomeChannelsRetiredKey({
  required String relayOrigin,
  required String pubkey,
}) =>
    'buzz-welcome-channels-retired.v1:${Uri.encodeComponent(relayOrigin)}:$pubkey';

/// Whether this start should run the one-time retirement. Kept pure so the
/// decision is directly testable; the notifier below is the only caller.
bool shouldRetireWelcomeChannels({
  required bool connected,
  required String? pubkey,
  required String? nsec,
  required bool alreadyRetired,
}) => connected && pubkey != null && nsec != null && !alreadyRetired;

/// Retires the channels earlier releases seeded, once per identity/community,
/// for installations that did not arrive through an invite. Best-effort and
/// idempotent: a failure leaves the marker unset so the next start retries.
///
/// The invite and hosted paths retire before home as part of their own flow;
/// this covers a plain app start.
class WelcomeChannelsRetirementNotifier extends Notifier<bool> {
  Future<void>? _inFlight;

  @override
  bool build() {
    final config = ref.watch(relayConfigProvider);
    final session = ref.watch(relaySessionProvider);
    final pubkey = ref.watch(myPubkeyProvider);
    final prefs = ref.read(savedPrefsProvider);
    final origin = config.baseUrl;
    final key = pubkey == null
        ? null
        : welcomeChannelsRetiredKey(relayOrigin: origin, pubkey: pubkey);
    final alreadyRetired = key != null && prefs.getBool(key) == true;
    if (!shouldRetireWelcomeChannels(
      connected: session.status == SessionStatus.connected,
      pubkey: pubkey,
      nsec: config.nsec,
      alreadyRetired: alreadyRetired,
    )) {
      return alreadyRetired;
    }
    // Non-null by the predicate above.
    final retiredPubkey = pubkey!;
    final retiredKey = key!;

    _inFlight ??= _retire(
      origin: origin,
      pubkey: retiredPubkey,
      key: retiredKey,
    ).whenComplete(() => _inFlight = null);
    return false;
  }

  Future<void> _retire({
    required String origin,
    required String pubkey,
    required String key,
  }) async {
    try {
      final recovery = ref.read(inviteJoinRecoveryProvider)(
        InviteJoinRecoveryScope(
          relayHttpOrigin: origin,
          nsec: ref.read(relayConfigProvider).nsec!,
        ),
      );
      await recovery.retireWelcomeChannels();
      await ref.read(savedPrefsProvider).setBool(key, true);
      if (ref.mounted) state = true;
    } catch (_) {
      // Leave the marker unset; the next start retries.
    }
  }
}

final welcomeChannelsRetirementProvider =
    NotifierProvider<WelcomeChannelsRetirementNotifier, bool>(
      WelcomeChannelsRetirementNotifier.new,
    );
