// @polsia:user-owned — deploy-time database seed. You OWN this file.
//
// seed() runs once when the server boots (via the framework-owned
// src/instrumentation.ts), on the Node server, AFTER the schema is applied. Use it
// for reference/lookup data your app needs to exist BEFORE the first request:
// plans, categories, feature defaults, a first admin row, etc. Read/write the DB
// through the Prisma singleton in @/lib/db (server startup — there is no request,
// so this does NOT go through /api).
//
// RULES — this runs on EVERY deploy/boot, possibly more than once, possibly on more
// than one instance at the same time:
//   1. Make every write IDEMPOTENT — upsert (`where` + `create` + `update`) or
//      `createMany({ ..., skipDuplicates: true })`, NEVER a bare `create`/`insert`.
//   2. Keep it fast and small — it runs before the server serves traffic.
//   3. NOT for recurring work (that's polsia.toml `[[crons]]`) or per-user/
//      request-time logic (that's an /api route handler). There is no request here.
//
// The template ships an empty seed (a no-op). Fill in the body when your app needs
// it; leave it empty to keep seeding off. Don't delete the file — instrumentation.ts
// imports it.
export async function seed(): Promise<void> {
  const { prisma } = await import('@/lib/db');
  const teams = await prisma.team.findMany({
    select: {
      id: true,
      name: true,
      createdAt: true,
      trials: { select: { ownerUserId: true } },
    },
  });

  if (teams.length === 0) return;

  const admins = await prisma.membership.findMany({
    where: {
      teamId: { in: teams.map((team) => team.id) },
      role: 'admin',
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { teamId: true, userId: true },
  });
  const earliestAdminByTeam = new Map<string, string>();

  for (const admin of admins) {
    if (!earliestAdminByTeam.has(admin.teamId)) {
      earliestAdminByTeam.set(admin.teamId, admin.userId);
    }
  }

  await prisma.workspace.createMany({
    data: teams.map((team) => ({
      id: team.id,
      name: team.name,
      ownerUserId: team.trials[0]?.ownerUserId ?? earliestAdminByTeam.get(team.id) ?? null,
      createdAt: team.createdAt,
    })),
    skipDuplicates: true,
  });
}
