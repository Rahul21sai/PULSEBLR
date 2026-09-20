import { pathToFileURL } from 'node:url';
import { expectedAssetLinkFingerprints, verifyProductionAssetLinks } from '../lib/digital-asset-links';

export async function diagnoseAssetLinks(
  environment: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await verifyProductionAssetLinks(expectedAssetLinkFingerprints(environment), fetchImpl);
}

async function main(): Promise<void> {
  try {
    await diagnoseAssetLinks(process.env);
    console.log('Digital Asset Links: PASS');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
