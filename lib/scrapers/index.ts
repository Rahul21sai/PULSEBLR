// Public surface of the scraper package.
//
// Structure:
//   core/      shared plumbing — HTTP, JSON-LD, ICS, geo, text, types
//   adapters/  one module per platform, each returning ScrapeResult
//   pipeline   the orchestrator: discover → scrape → enrich → tag → ingest → prune
//
// Callers should reach for `runPipeline` (or the `runAllScrapers` alias kept for
// the existing script and API route).

export * from './core/types';
export * from './core/geo';
export * from './core/http';
export * from './core/jsonld';
export * from './core/ics';
export * from './core/text';

export * from './adapters/luma';
export * from './adapters/meetup';
export * from './adapters/eventbrite';
export * from './adapters/bevy';
export * from './adapters/devfolio';
export * from './adapters/unstop';
export * from './adapters/allevents';
export * from './adapters/devevents';
export * from './adapters/hasgeek';
export * from './adapters/universal';

export * from './normalizer';
export * from './ingestion';
export { runPipeline, runAllScrapers } from './pipeline';
export type { PipelineOptions, PipelineResult, SourceReport } from './pipeline';
