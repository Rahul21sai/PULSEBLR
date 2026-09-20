import { pathToFileURL } from 'node:url';
import { expectedAssetLinkFingerprints, type AssetLinkEnvironment, verifyProductionAssetLinks } from '../lib/digital-asset-links';

export async function diagnoseAssetLinks(
  environment: AssetLinkEnvironment,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  await verifyProductionAssetLinks(expectedAssetLinkFingerprints(environment), fetchImpl);
  return 'Digital Asset Links: PASS';
}

async function main(): Promise<void> {
  try {
    console.log(await diagnoseAssetLinks(process.env as AssetLinkEnvironment));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
