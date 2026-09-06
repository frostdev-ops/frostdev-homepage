import type { CommsClient } from './types.ts';
import { discordClient } from './discord.ts';
import { telegramClient } from './telegram.ts';
import { slackClient } from './slack.ts';
import { twilioClient } from './twilio.ts';
import { matrixClient } from './matrix.ts';
import { teamsClient } from './teams.ts';

/** The op vocabulary every provider offers, for the tools' descriptions —
 *  built once per process, so the instructions stay byte-identical. */
export function opsDoc(): string {
  const probes: CommsClient[] = [
    discordClient('x', { guild: '', channel: '', watch: 'all' }, 'doc'),
    telegramClient('x', { channel: '', watch: 'all' }, 'doc'),
    slackClient('x', null, { channel: '', watch: 'all' }, 'doc'),
    twilioClient('x', { sid: '', from: '', channel: '' }, 'doc'),
    matrixClient('x', { homeserver: '', channel: '', watch: 'all' }, 'doc'),
    teamsClient(async () => 'x', { team: '', channel: '', watch: 'all' }, 'doc'),
  ];
  return probes.flatMap((p) => [`${p.type} — read: ${p.ops.read.join('; ')}`, `${p.type} — manage: ${p.ops.manage.join('; ')}`, `${p.type} — moderate: ${p.ops.moderate.join('; ')}`]).join('\n');
}
