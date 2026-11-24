// One-shot helper: insert a due CloudDiscoverySchedule + run the cron once
// to confirm end-to-end. Used for the smoke check described in the plan.
// Not a long-lived file — delete after verification.

import { prisma } from '../src/lib/db';

async function seed() {
  const team = await prisma.team.findFirst({ orderBy: { createdAt: 'asc' } });
  if (!team) throw new Error('seed: no team in DB');
  const user = await prisma.user.findFirst();
  const sched = await prisma.cloudDiscoverySchedule.create({
    data: {
      teamId: team.id,
      provider: 'aws',
      cadenceMinutes: 60,
      nextRunAt: new Date(Date.now() - 60_000),
      createdById: user?.id ?? 'system',
    },
  });
  console.log('Seeded sched id=', sched.id, 'nextRunAt=', sched.nextRunAt.toISOString());

  const after = await prisma.cloudDiscoverySchedule.findUnique({ where: { id: sched.id } });
  console.log('Before-cron: lastRunAt=', after?.lastRunAt);
}

seed()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
