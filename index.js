const core = require('@actions/core');
const { InfluxDB } = require('@influxdata/influxdb-client');
const fs = require('fs').promises;
const { parseJUnitXML } = require('./parser');

async function run() {
  try {
    // Get inputs
    const junitFile = core.getInput('junit-file', { required: true });
    const influxUrl = core.getInput('influx-url', { required: true });
    const influxOrg = core.getInput('influx-org', { required: true });
    const influxBucket = core.getInput('influx-bucket', { required: true });
    const influxToken = core.getInput('influx-token', { required: true });
    const runnerName = core.getInput('runner-name', { required: true });
    const tagsJson = core.getInput('tags');

    // Parse tags
    let tags = {};
    if (tagsJson && tagsJson !== '{}') {
      try {
        tags = JSON.parse(tagsJson);
      } catch (e) {
        core.warning(`Failed to parse tags: ${e.message}`);
      }
    }

    core.info(`Reading JUnit XML from: ${junitFile}`);
    const xmlContent = await fs.readFile(junitFile, 'utf8');

    core.info('Parsing JUnit XML...');
    const { points, statuses, metadata } = await parseJUnitXML(xmlContent);

    // Add runner metadata to all points
    for (const point of points) {
      point.tag('runner_name', runnerName);

      // Add custom tags
      for (const [key, value] of Object.entries(tags)) {
        if (typeof value === 'string') {
          point.tag(key, value);
        } else {
          core.warning(`Tag "${key}" has non-string value and will be skipped`);
        }
      }
    }

    core.info(`Parsed ${points.length} test results`);
    core.info(`Summary: ${metadata.totalTests} tests, ${metadata.failures} failures, ${metadata.errors} errors`);

    // Count by status
    const statusCounts = {};
    for (const status of statuses) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    core.info(`Status breakdown: ${JSON.stringify(statusCounts)}`);

    // Upload to InfluxDB
    core.info(`Connecting to InfluxDB at ${influxUrl}...`);
    const client = new InfluxDB({ url: influxUrl, token: influxToken });
    const writeApi = client.getWriteApi(influxOrg, influxBucket);

    // Write points in batches
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      writeApi.writePoints(batch);
      core.debug(`Wrote batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(points.length / batchSize)}`);
    }

    await writeApi.close();
    core.info(`✅ Successfully uploaded ${points.length} test results to InfluxDB`);

  } catch (error) {
    core.setFailed(`Action failed: ${error.message}`);
    if (error.stack) {
      core.debug(error.stack);
    }
  }
}

run();
