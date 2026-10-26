import 'package:buzz/shared/hosted/hosted_environment.dart';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart' as http_testing;
import 'package:nostr/nostr.dart' as nostr;
import 'package:pointycastle/digests/sha256.dart';

import 'package:buzz/app.dart';
import 'package:buzz/features/channels/channel.dart';
import 'package:buzz/features/channels/channel_management_provider.dart';
import 'package:buzz/features/invites/invite_join_provider.dart';
import 'package:buzz/shared/auth/auth.dart';
import 'package:buzz/shared/deeplink/deep_link.dart';

import '../../shared/community/community_storage_test.dart';

void main() {
  test(
    'legacy invite entry refuses staging before key generation or claim',
    () async {
      final storage = CommunityStorage(secure: FakeSecureStorage());
      var generated = 0;
      var requests = 0;
      final container = ProviderContainer(
        overrides: [
          communityStorageProvider.overrideWithValue(storage),
          inviteKeyGeneratorProvider.overrideWithValue(() {
            generated++;
            return nostr.Keys.generate();
          }),
          inviteJoinHttpClientProvider.overrideWithValue(
            http_testing.MockClient((_) async {
              requests++;
              return http.Response('{}', 500);
            }),
          ),
        ],
      );
      addTearDown(container.dispose);
      await container.read(communityListProvider.future);
      final notifier = container.read(inviteJoinProvider.notifier);
      await notifier.prepare(
        const InviteDeepLink(
          relayUrl: 'wss://team.communities.public.builderlabstaging.xyz',
          code: 'fixture',
        ),
      );
      await notifier.confirmJoin();
      expect(container.read(inviteJoinProvider).status, InviteJoinStatus.error);
      expect(generated, 0);
      expect(requests, 0);
      expect(await storage.loadAll(), isEmpty);
    },
    skip: !HostedEnvironment.requiresAuth(
      'team.communities.public.builderlabstaging.xyz',
    ),
  );

  for (final existingRelayUrl in [
    'wss://relay.example.com',
    'https://relay.example.com',
  ]) {
    test(
      'same-relay invite switches existing $existingRelayUrl before keygen or claim',
      () async {
        var generatedKeys = 0;
        var claimRequests = 0;
        final storage = CommunityStorage(secure: FakeSecureStorage());
        final existing = Community(
          id: 'existing-id',
          name: 'Existing',
          relayUrl: existingRelayUrl,
          pubkey: 'old-pubkey',
          nsec: 'old-nsec',
          addedAt: DateTime.utc(2026),
        );
        await storage.save(existing);
        final auth = _RecordingAuthNotifier();
        final container = ProviderContainer(
          overrides: [
            communityStorageProvider.overrideWithValue(storage),
            authProvider.overrideWith(() => auth),
            inviteKeyGeneratorProvider.overrideWithValue(() {
              generatedKeys++;
              return nostr.Keys.generate();
            }),
            inviteJoinHttpClientProvider.overrideWithValue(
              http_testing.MockClient((request) async {
                claimRequests++;
                return http.Response('{}', 500);
              }),
            ),
          ],
        );
        addTearDown(container.dispose);
        await container.read(communityListProvider.future);

        await container
            .read(inviteJoinProvider.notifier)
            .prepare(
              const InviteDeepLink(
                relayUrl: 'wss://relay.example.com',
                code: 'code',
              ),
            );

        final state = container.read(inviteJoinProvider);
        final stored = (await storage.loadAll()).single;
        expect(state.status, InviteJoinStatus.switchedExisting);
        expect(await storage.loadActiveId(), existing.id);
        expect(stored.relayUrl, existingRelayUrl);
        expect(stored.pubkey, 'old-pubkey');
        expect(stored.nsec, 'old-nsec');
        expect(generatedKeys, 0);
        expect(claimRequests, 0);
        expect(auth.authenticatedCommunities, isEmpty);
      },
    );
  }

  test(
    'claim posts with freshly-generated key and stores joined community',
    () async {
      final keys = nostr.Keys.generate();
      http.Request? capturedRequest;
      final storage = CommunityStorage(secure: FakeSecureStorage());
      final auth = _RecordingAuthNotifier();
      final container = ProviderContainer(
        overrides: [
          communityStorageProvider.overrideWithValue(storage),
          authProvider.overrideWith(() => auth),
          inviteKeyGeneratorProvider.overrideWithValue(() => keys),
          inviteJoinRecoveryProvider.overrideWithValue(
            (_) => _successfulRecovery(),
          ),
          inviteJoinHttpClientProvider.overrideWithValue(
            http_testing.MockClient((request) async {
              capturedRequest = request;
              return http.Response(
                jsonEncode({
                  'status': 'joined',
                  'community_id': 'community-id',
                  'host': 'relay.example.com',
                  'role': 'member',
                }),
                200,
              );
            }),
          ),
        ],
      );
      addTearDown(container.dispose);

      await container
          .read(inviteJoinProvider.notifier)
          .prepare(
            const InviteDeepLink(
              relayUrl: 'wss://relay.example.com',
              code: 'code',
            ),
          );
      expect(
        container.read(inviteJoinProvider).status,
        InviteJoinStatus.confirming,
      );

      await container.read(inviteJoinProvider.notifier).confirmJoin();

      final state = container.read(inviteJoinProvider);
      expect(state.status, InviteJoinStatus.success);
      expect(capturedRequest, isNotNull);
      expect(
        capturedRequest!.url.toString(),
        'https://relay.example.com/api/invites/claim',
      );
      expect(capturedRequest!.body, jsonEncode({'code': 'code'}));
      final authHeader = capturedRequest!.headers['Authorization'];
      expect(authHeader, startsWith('Nostr '));
      expect(capturedRequest!.followRedirects, isFalse);
      final encoded = authHeader!.substring('Nostr '.length);
      final authEvent =
          jsonDecode(
                utf8.decode(base64Url.decode(base64Url.normalize(encoded))),
              )
              as Map<String, dynamic>;
      final tags = (authEvent['tags'] as List<dynamic>)
          .map((tag) => (tag as List<dynamic>).cast<String>())
          .toList();
      final payloadHash = SHA256Digest()
          .process(capturedRequest!.bodyBytes)
          .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
          .join();
      expect(authEvent['kind'], 27235);
      expect(tags, contains(equals(['u', capturedRequest!.url.toString()])));
      expect(tags, contains(equals(['method', 'POST'])));
      expect(tags, contains(equals(['payload', payloadHash])));
      expect(auth.authenticatedCommunities, hasLength(1));
      expect(
        auth.authenticatedCommunities.single.relayUrl,
        'wss://relay.example.com',
      );
      expect(auth.authenticatedCommunities.single.pubkey, keys.public);
      expect(auth.authenticatedCommunities.single.nsec, keys.nsec);
      expect(
        auth.authenticatedCommunities.single.sensitiveActionPolicy,
        SensitiveActionPolicy.disabledByUser,
      );
    },
  );

  test('prepare rejects an unsafe relay before showing confirmation', () async {
    final container = ProviderContainer();
    addTearDown(container.dispose);

    await expectLater(
      container
          .read(inviteJoinProvider.notifier)
          .prepare(
            const InviteDeepLink(relayUrl: 'wss://127.0.0.1', code: 'code'),
          ),
      throwsFormatException,
    );
    expect(container.read(inviteJoinProvider).status, InviteJoinStatus.idle);
  });

  test('starter channel ids match desktop for the same relay scope', () async {
    expect(
      desktopStarterChannelId(
        relayHttpOrigin: 'https://relay.example.com/',
        slug: 'general',
      ),
      '9ed9563a-84d6-586d-8007-ae294a6dfdaf',
    );
    expect(
      desktopStarterChannelId(
        relayHttpOrigin: 'https://relay.example.com',
        slug: 'welcome-everyone',
      ),
      '1e288e10-2f7d-5c2c-9a9f-dee58c8daa7a',
    );
  });

  test('invite recovery leaves the legacy public starters', () async {
    final left = <String>[];
    final recovery = MobileInviteJoinRecovery(
      loadChannels: () async => [
        _channel(
          id: desktopStarterChannelId(
            relayHttpOrigin: 'https://relay.example.com',
            slug: 'general',
          ),
          name: 'general',
          isMember: true,
        ),
        _channel(
          id: desktopStarterChannelId(
            relayHttpOrigin: 'https://relay.example.com',
            slug: 'welcome-everyone',
          ),
          name: 'welcome-everyone',
          isMember: true,
        ),
      ],
      loadMembers: (_) async => const [],
      leaveChannel: (channelId) async => left.add(channelId),
      deleteChannel: (channelId) async => fail('must not delete'),
      relayHttpOrigin: 'https://relay.example.com',
    );

    await recovery.retireWelcomeChannels();

    expect(left, [
      '9ed9563a-84d6-586d-8007-ae294a6dfdaf',
      '1e288e10-2f7d-5c2c-9a9f-dee58c8daa7a',
    ]);
  });

  test('retirement ignores a same-named channel the community owns', () async {
    final left = <String>[];
    final recovery = MobileInviteJoinRecovery(
      loadChannels: () async => [
        // Same name, but not the deterministic starter id: this is a channel
        // the community created on purpose.
        _channel(id: 'community-general', name: 'general', isMember: true),
      ],
      loadMembers: (_) async => const [],
      leaveChannel: (channelId) async => left.add(channelId),
      deleteChannel: (channelId) async => fail('must not delete'),
      relayHttpOrigin: 'https://relay.example.com',
    );

    await recovery.retireWelcomeChannels();

    expect(left, isEmpty);
  });

  test('retirement deletes a solo owner private Welcome', () async {
    final left = <String>[];
    final deleted = <String>[];
    final recovery = MobileInviteJoinRecovery(
      loadChannels: () async => [
        _channel(
          id: 'welcome-id',
          name: 'Welcome',
          visibility: 'private',
          isMember: true,
        ),
      ],
      loadMembers: (_) async => [
        _member('me', role: 'owner'),
        _member('agent', role: 'bot'),
      ],
      leaveChannel: (channelId) async => left.add(channelId),
      deleteChannel: (channelId) async => deleted.add(channelId),
      relayHttpOrigin: 'https://relay.example.com',
      currentPubkey: 'me',
    );

    await recovery.retireWelcomeChannels();

    expect(deleted, ['welcome-id']);
    expect(left, isEmpty);
  });

  test(
    "retirement leaves another human's Welcome instead of deleting it",
    () async {
      final left = <String>[];
      final deleted = <String>[];
      final recovery = MobileInviteJoinRecovery(
        loadChannels: () async => [
          _channel(
            id: 'welcome-id',
            name: 'Welcome',
            visibility: 'private',
            isMember: true,
          ),
        ],
        loadMembers: (_) async => [
          _member('other', role: 'owner'),
          _member('me', role: 'member'),
        ],
        leaveChannel: (channelId) async => left.add(channelId),
        deleteChannel: (channelId) async => deleted.add(channelId),
        relayHttpOrigin: 'https://relay.example.com',
        currentPubkey: 'me',
      );

      await recovery.retireWelcomeChannels();

      expect(left, ['welcome-id']);
      expect(deleted, isEmpty);
    },
  );

  test(
    'retirement propagates a failure instead of reporting success',
    () async {
      final recovery = MobileInviteJoinRecovery(
        loadChannels: () async => [
          _channel(
            id: desktopStarterChannelId(
              relayHttpOrigin: 'https://relay.example.com',
              slug: 'general',
            ),
            name: 'general',
            isMember: true,
          ),
        ],
        loadMembers: (_) async => const [],
        leaveChannel: (_) async => throw Exception('relay unavailable'),
        deleteChannel: (_) async => fail('must not delete'),
        relayHttpOrigin: 'https://relay.example.com',
      );

      await expectLater(
        recovery.retireWelcomeChannels(),
        throwsA(isA<Exception>()),
      );
    },
  );

  test('join_policy_required requires a fresh link and cannot retry', () async {
    final keys = nostr.Keys.generate();
    var attempts = 0;
    final storage = CommunityStorage(secure: FakeSecureStorage());
    final container = ProviderContainer(
      overrides: [
        communityStorageProvider.overrideWithValue(storage),
        inviteKeyGeneratorProvider.overrideWithValue(() => keys),
        inviteJoinHttpClientProvider.overrideWithValue(
          http_testing.MockClient((request) async {
            attempts++;
            return http.Response(
              jsonEncode({'error': 'join_policy_required'}),
              403,
            );
          }),
        ),
      ],
    );
    addTearDown(container.dispose);

    await container
        .read(inviteJoinProvider.notifier)
        .prepare(
          const InviteDeepLink(
            relayUrl: 'wss://relay.example.com',
            code: 'code',
            policyReceipt: 'expired.receipt',
          ),
        );
    await container.read(inviteJoinProvider.notifier).confirmJoin();

    final state = container.read(inviteJoinProvider);
    expect(state.status, InviteJoinStatus.error);
    expect(state.requiresFreshInvite, isTrue);
    expect(
      state.errorMessage,
      'This invite approval has expired. Re-open the invite link to try again.',
    );

    await container.read(inviteJoinProvider.notifier).confirmJoin();
    expect(attempts, 1);
  });

  test('invite_exhausted requires a fresh invite and cannot retry', () async {
    final keys = nostr.Keys.generate();
    var attempts = 0;
    final storage = CommunityStorage(secure: FakeSecureStorage());
    final container = ProviderContainer(
      overrides: [
        communityStorageProvider.overrideWithValue(storage),
        inviteKeyGeneratorProvider.overrideWithValue(() => keys),
        inviteJoinHttpClientProvider.overrideWithValue(
          http_testing.MockClient((request) async {
            attempts++;
            return http.Response(
              jsonEncode({'error': 'invite_exhausted'}),
              403,
            );
          }),
        ),
      ],
    );
    addTearDown(container.dispose);

    await container
        .read(inviteJoinProvider.notifier)
        .prepare(
          const InviteDeepLink(
            relayUrl: 'wss://relay.example.com',
            code: 'v2.exhausted-secret',
          ),
        );
    await container.read(inviteJoinProvider.notifier).confirmJoin();

    final state = container.read(inviteJoinProvider);
    expect(state.status, InviteJoinStatus.error);
    expect(state.requiresFreshInvite, isTrue);
    expect(
      state.errorMessage,
      'This invite has reached its use limit. Ask for a new invite.',
    );

    await container.read(inviteJoinProvider.notifier).confirmJoin();
    expect(attempts, 1);
  });

  test('failed claim can be retried and preserves policy receipt', () async {
    final keys = nostr.Keys.generate();
    var attempts = 0;
    final bodies = <String>[];
    final storage = CommunityStorage(secure: FakeSecureStorage());
    final auth = _RecordingAuthNotifier();
    final container = ProviderContainer(
      overrides: [
        communityStorageProvider.overrideWithValue(storage),
        authProvider.overrideWith(() => auth),
        inviteKeyGeneratorProvider.overrideWithValue(() => keys),
        inviteJoinRecoveryProvider.overrideWithValue(
          (_) => _successfulRecovery(),
        ),
        inviteJoinHttpClientProvider.overrideWithValue(
          http_testing.MockClient((request) async {
            attempts++;
            bodies.add(request.body);
            if (attempts == 1) {
              return http.Response(jsonEncode({'error': 'temporary'}), 503);
            }
            return http.Response(
              jsonEncode({
                'status': 'joined',
                'host': 'relay.example.com',
                'role': 'member',
              }),
              200,
            );
          }),
        ),
      ],
    );
    addTearDown(container.dispose);

    await container
        .read(inviteJoinProvider.notifier)
        .prepare(
          const InviteDeepLink(
            relayUrl: 'wss://relay.example.com',
            code: 'code',
            policyReceipt: 'receipt.value',
          ),
        );
    await container.read(inviteJoinProvider.notifier).confirmJoin();
    expect(container.read(inviteJoinProvider).status, InviteJoinStatus.error);

    await container.read(inviteJoinProvider.notifier).confirmJoin();

    expect(container.read(inviteJoinProvider).status, InviteJoinStatus.success);
    expect(attempts, 2);
    expect(
      bodies,
      everyElement(
        jsonEncode({'code': 'code', 'policy_receipt': 'receipt.value'}),
      ),
    );
    expect(auth.authenticatedCommunities, hasLength(1));
  });

  test('builds a fresh recovery with the second community identity', () async {
    final firstKeys = nostr.Keys.generate();
    final secondKeys = nostr.Keys.generate();
    final scopes = <InviteJoinRecoveryScope>[];
    final recoveries = <InviteJoinRecoveryScope>[];
    var nextKeys = 0;
    final container = ProviderContainer(
      overrides: [
        communityStorageProvider.overrideWithValue(
          CommunityStorage(secure: FakeSecureStorage()),
        ),
        authProvider.overrideWith(_RecordingAuthNotifier.new),
        inviteKeyGeneratorProvider.overrideWithValue(() {
          final keys = nextKeys == 0 ? firstKeys : secondKeys;
          nextKeys++;
          return keys;
        }),
        inviteJoinRecoveryProvider.overrideWithValue((scope) {
          scopes.add(scope);
          return _RecordingInviteJoinRecovery(() async {
            recoveries.add(scope);
          });
        }),
        inviteJoinHttpClientProvider.overrideWithValue(
          http_testing.MockClient(
            (request) async => http.Response(
              jsonEncode({
                'status': 'joined',
                'host': request.url.host,
                'role': 'member',
              }),
              200,
            ),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    for (final invite in const [
      InviteDeepLink(relayUrl: 'wss://first.example.com', code: 'first'),
      InviteDeepLink(relayUrl: 'wss://second.example.com', code: 'second'),
    ]) {
      await container.read(inviteJoinProvider.notifier).prepare(invite);
      await container.read(inviteJoinProvider.notifier).confirmJoin();
      expect(
        container.read(inviteJoinProvider).status,
        InviteJoinStatus.success,
      );
    }

    expect(scopes.map((scope) => scope.relayHttpOrigin), [
      'https://first.example.com',
      'https://second.example.com',
    ]);
    expect(scopes.map((scope) => scope.nsec), [
      firstKeys.nsec,
      secondKeys.nsec,
    ]);
    expect(recoveries, hasLength(2));
    expect(identical(recoveries[0], scopes[0]), isTrue);
    expect(identical(recoveries[1], scopes[1]), isTrue);
    expect(identical(recoveries[1], scopes[0]), isFalse);
  });
}

InviteJoinRecovery _successfulRecovery() => const _FakeInviteJoinRecovery();

class _FakeInviteJoinRecovery implements InviteJoinRecovery {
  const _FakeInviteJoinRecovery();

  @override
  Future<void> retireWelcomeChannels() async {}
}

class _RecordingInviteJoinRecovery implements InviteJoinRecovery {
  const _RecordingInviteJoinRecovery(this._retire);

  final Future<void> Function() _retire;

  @override
  Future<void> retireWelcomeChannels() => _retire();
}

Channel _channel({
  required String id,
  required String name,
  String visibility = 'open',
  bool isMember = false,
}) => Channel(
  id: id,
  name: name,
  channelType: 'stream',
  visibility: visibility,
  description: '',
  createdBy: 'me',
  createdAt: DateTime.utc(2026),
  memberCount: isMember ? 1 : 0,
  isMember: isMember,
);

ChannelMember _member(String pubkey, {required String role}) =>
    ChannelMember(pubkey: pubkey, role: role, joinedAt: DateTime.utc(2026));

class _RecordingAuthNotifier extends AuthNotifier {
  final List<Community> authenticatedCommunities = [];

  @override
  Future<AuthState> build() async =>
      const AuthState(status: AuthStatus.unauthenticated);

  @override
  Future<void> authenticateWithCommunity(
    Community community, {
    bool Function()? shouldContinue,
    bool activate = true,
  }) async {
    if (shouldContinue != null && !shouldContinue()) return;
    final storage = ref.read(communityStorageProvider);
    await storage.save(community);
    await storage.saveActiveId(community.id);
    ref.invalidate(communityListProvider);
    ref.invalidate(activeCommunityProvider);
    authenticatedCommunities.add(community);
    state = AsyncData(
      AuthState(status: AuthStatus.authenticated, community: community),
    );
  }
}
