#!/usr/bin/env tsx
/**
 * Manual scraper runner
 * Usage: npm run scrape
 */

import { runAllScrapers } from '../lib/scrapers';

async function main() {
  console.log('='.repeat(60));
  console.log('PulseBLR Event Scraper');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    const result = await runAllScrapers();
    
    console.log('');
    console.log('='.repeat(60));
    console.log('SCRAPER RUN SUMMARY');
    console.log('='.repeat(60));
    console.log(`Timestamp: ${result.timestamp.toISOString()}`);
    console.log(`Duration: ${(result.duration / 1000).toFixed(2)}s`);
    console.log('');
    console.log(`Total Scraped: ${result.totalScraped}`);
    console.log(`Total Normalized: ${result.totalNormalized}`);
    console.log('');
    console.log('Ingestion Results:');
    console.log(`  ✅ Inserted: ${result.ingestion.inserted}`);
    console.log(`  ⏭️  Duplicates: ${result.ingestion.duplicates}`);
    console.log(`  ❌ Errors: ${result.ingestion.errors}`);
    console.log('');
    
    if (result.errors.length > 0) {
      console.log('Errors encountered:');
      result.errors.forEach((error, i) => {
        console.log(`  ${i + 1}. ${error}`);
      });
      console.log('');
    }
    
    if (result.ingestion.errorDetails.length > 0) {
      console.log('Ingestion errors:');
      result.ingestion.errorDetails.forEach((error, i) => {
        console.log(`  ${i + 1}. ${error}`);
      });
      console.log('');
    }
    
    console.log('='.repeat(60));
    
    process.exit(result.ingestion.errors > 0 ? 1 : 0);
    
  } catch (error) {
    console.error('');
    console.error('❌ Fatal error running scrapers:');
    console.error(error);
    console.error('');
    process.exit(1);
  }
}

main();

// Made with Bob