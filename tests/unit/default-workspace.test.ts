// @polsia:user-owned — Coverage for signup workspace repair and idempotency.
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionDefaultWorkspace } from '@/lib/business/default-workspace';

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/db', () => ({ prisma: { $transaction: transaction } }));

type ProvisioningClient = Parameters<typeof provisionDefaultWorkspace>[0];

const owner = { id: 'user-1', email: 'New.User@example.invalid' };
const team = { id: 'team-1', name: 'ws-new-user' };

function makeClient() {
  return {
    team: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn().mockResolvedValue(team),
      create: vi.fn().mockResolvedValue(team),
    },
    membership: {
      findUnique: vi.fn().mockResolvedValue({ teamId: team.id }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ teamId: team.id }),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
    workspaceMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn(),
    },
  } as unknown as ProvisioningClient;
}

describe('default workspace provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('repairs missing workspace and owner roster rows for the canonical membership', async () => {
    const client = makeClient();

    await expect(provisionDefaultWorkspace(client, owner)).resolves.toEqual({ teamId: team.id });

    expect(client.membership.upsert).not.toHaveBeenCalled();
    expect(client.workspace.upsert).toHaveBeenCalledWith({
      where: { id: team.id },
      create: { id: team.id, name: team.name, ownerUserId: owner.id },
      update: { ownerUserId: owner.id },
    });
    expect(client.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId_email: { workspaceId: team.id, email: owner.email.toLowerCase() } },
        create: expect.objectContaining({ role: 'admin', status: 'active', userId: owner.id }),
        update: expect.objectContaining({ role: 'admin', status: 'active', userId: owner.id }),
      }),
    );
  });

  it('keeps an existing membership and workspace owner while repairing the roster', async () => {
    const client = makeClient();
    client.workspace.findUnique = vi.fn().mockResolvedValue({ ownerUserId: 'another-user' });
    client.workspaceMember.findUnique = vi.fn().mockResolvedValue({ joinedAt: null });

    await provisionDefaultWorkspace(client, owner);

    expect(client.membership.upsert).not.toHaveBeenCalled();
    expect(client.workspace.upsert).toHaveBeenCalledWith({
      where: { id: team.id },
      create: { id: team.id, name: team.name, ownerUserId: owner.id },
      update: {},
    });
    expect(client.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ joinedAt: expect.any(Date) }),
      }),
    );
  });

  it('uses the existing workspace label and creates its first membership', async () => {
    const client = makeClient();
    client.membership.findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ teamId: team.id });
    client.team.findUnique = vi.fn().mockResolvedValue(null);
    client.team.create = vi.fn().mockResolvedValue(team);

    await provisionDefaultWorkspace(client, owner);

    expect(client.team.create).toHaveBeenCalledWith({ data: { name: 'ws-new-user' } });
    expect(client.membership.upsert).toHaveBeenCalledWith({
      where: { userId: owner.id },
      create: { userId: owner.id, teamId: team.id, role: 'admin' },
      update: {},
    });
  });

  it('concurrent retries converge on the same existing membership', async () => {
    const client = makeClient();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => provisionDefaultWorkspace(client, owner)),
    );

    expect(results).toEqual(Array.from({ length: 5 }, () => ({ teamId: team.id })));
    expect(client.team.create).not.toHaveBeenCalled();
    expect(client.membership.upsert).not.toHaveBeenCalled();
    expect(client.workspace.upsert).toHaveBeenCalledTimes(5);
    expect(client.workspaceMember.upsert).toHaveBeenCalledTimes(5);
  });
});
