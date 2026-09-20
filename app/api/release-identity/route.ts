export const dynamic = 'force-dynamic';

const noStoreHeaders = { 'cache-control': 'no-store' };

function deployedCommitSha(): string | undefined {
  const candidate = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.PULSEBLR_RELEASE_COMMIT_SHA;
  return candidate && /^[0-9a-f]{40}$/i.test(candidate) ? candidate.toLowerCase() : undefined;
}

export async function GET(): Promise<Response> {
  const commitSha = deployedCommitSha();
  if (!commitSha) {
    return Response.json({ error: 'release identity unavailable' }, { status: 503, headers: noStoreHeaders });
  }
  return Response.json({ commitSha }, { headers: noStoreHeaders });
}
