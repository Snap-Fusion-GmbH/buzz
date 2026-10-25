import 'package:flutter_test/flutter_test.dart';

import 'package:buzz/features/invites/welcome_channels_retirement.dart';

void main() {
  group('shouldRetireWelcomeChannels', () {
    test('runs only for a connected identity that has not retired yet', () {
      expect(
        shouldRetireWelcomeChannels(
          connected: true,
          pubkey: 'pubkey',
          nsec: 'nsec',
          alreadyRetired: false,
        ),
        isTrue,
      );
    });

    test('never runs before the relay session connects', () {
      expect(
        shouldRetireWelcomeChannels(
          connected: false,
          pubkey: 'pubkey',
          nsec: 'nsec',
          alreadyRetired: false,
        ),
        isFalse,
      );
    });

    test('skips an identity that already retired', () {
      expect(
        shouldRetireWelcomeChannels(
          connected: true,
          pubkey: 'pubkey',
          nsec: 'nsec',
          alreadyRetired: true,
        ),
        isFalse,
      );
    });

    test('skips missing identity material', () {
      for (final (pubkey, nsec) in [
        (null, 'nsec'),
        ('pubkey', null),
        (null, null),
      ]) {
        expect(
          shouldRetireWelcomeChannels(
            connected: true,
            pubkey: pubkey,
            nsec: nsec,
            alreadyRetired: false,
          ),
          isFalse,
        );
      }
    });
  });

  test('the retirement marker is scoped by community and identity', () {
    final first = welcomeChannelsRetiredKey(
      relayOrigin: 'https://relay-a.example',
      pubkey: 'alice',
    );
    final otherCommunity = welcomeChannelsRetiredKey(
      relayOrigin: 'https://relay-b.example',
      pubkey: 'alice',
    );
    final otherIdentity = welcomeChannelsRetiredKey(
      relayOrigin: 'https://relay-a.example',
      pubkey: 'bob',
    );

    expect(first, isNot(otherCommunity));
    expect(first, isNot(otherIdentity));
    expect(
      first,
      'buzz-welcome-channels-retired.v1:https%3A%2F%2Frelay-a.example:alice',
    );
  });
}
