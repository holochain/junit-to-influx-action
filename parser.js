const { parseStringPromise } = require('xml2js');
const { Point } = require('@influxdata/influxdb-client');

// Field size limit for InfluxDB (32KB)
const MAX_FIELD_SIZE = 32 * 1024;

function truncateField(value, maxSize = MAX_FIELD_SIZE) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxSize) return value;
  return value.substring(0, maxSize) + '\n[...truncated]';
}

// Helper functions for safe parsing
function safeParseInt(value, fallback = 0) {
  const parsed = parseInt(value);
  return isNaN(parsed) ? fallback : parsed;
}

function safeParseFloat(value, fallback = 0.0) {
  const parsed = parseFloat(value);
  return isNaN(parsed) || !isFinite(parsed) ? fallback : parsed;
}

function safeParseTimestamp(value, fallback) {
  if (!value) return fallback || new Date();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? (fallback || new Date()) : parsed;
}

async function parseJUnitXML(xmlContent) {
  const result = await parseStringPromise(xmlContent);
  const testsuites = result.testsuites;

  const suiteTimestamp = safeParseTimestamp(testsuites.$.timestamp);
  const metadata = {
    name: testsuites.$.name,
    totalTests: safeParseInt(testsuites.$.tests),
    failures: safeParseInt(testsuites.$.failures),
    errors: safeParseInt(testsuites.$.errors),
    uuid: testsuites.$.uuid,
    timestamp: suiteTimestamp,
    totalDuration: safeParseFloat(testsuites.$.time)
  };

  const points = [];
  const statuses = [];

  for (const testsuite of testsuites.testsuite) {
    const suiteName = testsuite.$.name;

    for (const testcase of testsuite.testcase) {
      const timestamp = safeParseTimestamp(testcase.$.timestamp, suiteTimestamp);
      const point = new Point('test_result')
        .tag('test_suite', suiteName)
        .tag('test_name', testcase.$.name)
        .tag('class_name', testcase.$.classname)
        .floatField('duration', safeParseFloat(testcase.$.time))
        .intField('suite_total_tests', metadata.totalTests)
        .intField('suite_failures', metadata.failures)
        .intField('suite_errors', metadata.errors)
        .floatField('suite_total_duration', metadata.totalDuration)
        .timestamp(timestamp);

      // Determine status
      let status = 'passed';
      let hasFailure = false;
      let hasFlakyFailure = false;

      // Check for flaky failure
      if (testcase.flakyFailure && testcase.flakyFailure.length > 0) {
        hasFlakyFailure = true;
        status = 'flaky';
        const flakyFailure = testcase.flakyFailure[0];

        point.floatField('flaky_duration', safeParseFloat(flakyFailure.$.time));
        if (flakyFailure.$.message) {
          point.stringField('flaky_message', truncateField(flakyFailure.$.message));
        }
        if (flakyFailure.$.type) {
          point.stringField('flaky_type', flakyFailure.$.type);
        }
        if (flakyFailure._) {
          point.stringField('flaky_details', truncateField(flakyFailure._));
        }
      }

      // Check for regular failure
      if (testcase.failure && testcase.failure.length > 0) {
        hasFailure = true;
        status = 'failed';
        const failure = testcase.failure[0];

        if (failure.$.message) {
          point.stringField('failure_message', truncateField(failure.$.message));
        }
        if (failure.$.type) {
          point.stringField('failure_type', failure.$.type);
        }
        if (failure._) {
          point.stringField('failure_details', truncateField(failure._));
        }
      }

      point.tag('status', status);
      point.intField('has_failure', hasFailure ? 1 : 0);
      point.intField('has_flaky_failure', hasFlakyFailure ? 1 : 0);

      // Track status for summary
      statuses.push(status);

      points.push(point);
    }
  }

  return { points, statuses, metadata };
}

module.exports = { parseJUnitXML };
