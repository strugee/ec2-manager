const aws = require('aws-sdk');
const sqslib = require('sqs-simple');
const _ = require('lodash');
const events = require('events');
const assert = require('assert');
const {runAWSRequest} = require('./aws-request');
const log = require('./log');

function missingTags(obj) {
  let hasTag = false;
  if (obj.Tags) {
    for (let tag of obj.Tags) {
      if (tag.Key === 'Owner') {
        hasTag = true;
      }
    }
  }
  return !hasTag;
};

class CloudWatchEventListener extends events.EventEmitter {

  constructor({
    state,
    sqs,
    ec2,
    queueName = 'ec2-events',
    monitor,
    region,
    keyPrefix,
    runaws = runAWSRequest,
    tagger,
  }) {
    super();
    
    // Store the reference to the State we're using
    assert(typeof state === 'object');
    this.state = state;

    // Store the list of regions in which we're operating
    assert(typeof region === 'string');
    this.region = region;

    // Store some basic configuration values
    assert(typeof queueName === 'string');
    this.queueName = queueName;

    // We want to ensure that the keyPrefix is in the correct trailing colon
    // format passed in to avoid confusion, but we only internally use it as
    // the actual value without the colon, so we store that here
    assert(typeof keyPrefix === 'string');
    assert(keyPrefix[keyPrefix.length - 1] === ':');
    this.provisionerId = keyPrefix.slice(0, keyPrefix.length - 1);
    this.keyPrefix = keyPrefix;

    // Set up all the AWS clients that we'll possibly need
    assert(sqs);
    this.sqs = sqs;

    assert(ec2);
    this.ec2 = ec2;

    // We should always be using a
    assert(this.ec2.config.region === region);
    assert(this.sqs.config.region === region);

    // Store the reference to the monitor instance
    this.monitor = monitor.prefix('cloud-watch-events');

    assert(typeof tagger === 'object');
    this.tagger = tagger;

    this.queueUrl = undefined;

    this.sqsQueue = undefined;

    this.runaws = runaws;
  }

  async init() {
    this.queueUrl = await sqslib.getQueueUrl({sqs: this.sqs, queueName: this.queueName});

    this.sqsQueue = new sqslib.QueueListener({
      sqs: this.sqs,
      queueUrl: this.queueUrl,
      decodeMessage: false,
      maxNumberOfMessages: 10,
      sequential: true,
      handler: async msg => {
        let doodad = this.monitor.timeKeeper('message-handler-time');
        await this.__handler(msg);
        doodad.measure();
        this.monitor.count('handled-messages', 1);
      },
    });

    this.sqsQueue.on('error', (err, errType) => {
      // We probably want to bubble this up... maybe?
      //this.emit('error', err, errType);
      this.monitor.count('handler-errors', 1);
      log.error({err, errType}, 'SQS Handler Error');
      this.monitor.reportError(err, {errType});
    });
  }

  async __handler(msg) {
    let body = JSON.parse(msg);
    let region = body.region;
    let id = body.detail['instance-id'];
    let state = body.detail.state;
    // Not a great name, but this variable is the time that the CloudWatch
    // Event message was generated by the API, not the time at which we
    // received it
    let generated = new Date(body.time);

    try {
      await this.state.logCloudWatchEvent({region, id, state, generated});
    } catch (err) {
      // We don't want to block things, but let's bubble up the error for the
      // time being
      this.monitor.reportError(err);
    }

    let dbResponse;

    let transaction = await this.state.beginTransaction();

    try {
      let x = await this.state.listInstances({region, id}, transaction);
      assert(Array.isArray(x));
      assert(x.length === 0 || x.length === 1);
      if (x.length === 1) {
        dbResponse = x[0];
      }
    } catch (err) {
      await this.state.rollbackTransaction(transaction);
      log.error(err, 'Error looking up state from database');
    }

    // We want to close this transaction if we didn't find anything in the database.
    // We'll use a new transaction if we're looking up from the API, but if we got
    // the information from the database, let's store it with the same transaction
    if (!dbResponse) {
      await this.state.commitTransaction(transaction);
    }

    if (dbResponse) {
      // If there's a response from the database, we know that we already have
      // this information in the database.  We'll use this information to
      // figure out the immutable metadata

      // Simple assertions, so may as well check for them.  If these failed,
      // something would be foundationally wrong

      assert(dbResponse.id === id);
      assert(dbResponse.region === region);

      let logInfo = {
        workerType: dbResponse.workertype,
        region: dbResponse.region,
        az: dbResponse.az,
        id: id,
        instanceType: dbResponse.instancetype,
        srid: dbResponse.srid,
        imageId: dbResponse.imageId,
        launched: dbResponse.launched,
        state,
        lastevent: generated,
        metadataSource: 'db',
      };
      
      if (dbResponse.lastevent && dbResponse.lastevent < generated) {
        try {
          if (state === 'pending' || state === 'running') {
            await this.state.updateInstanceState({region, id, state, lastevent: generated}, transaction);
            log.info(logInfo, 'CloudWatch Event resulting in insertion');
          } else {
            await this.state.removeInstance({region, id}, transaction);
            log.debug(logInfo, 'CloudWatch Event resulting in deletion');
          }
          await this.state.commitTransaction(transaction);
        } catch (err) {
          await this.state.rollbackTransaction(transaction);
          log.error(err, 'trying to update or remove instance');
          throw err;
        }
      } else {
        // While we didn't write anything, we did lock the row and claim a
        // client.  We should release those
        await this.state.commitTransaction(transaction);

        this.monitor.count('global.cwe-out-of-order.count', 1);
        this.monitor.count(`${region}.cwe-out-of-order.count`, 1);
        // We want to see how big our gaps in out of order delivery are.
        let delay = dbResponse.lastevent - generated;
        this.monitor.measure('global.cwe-out-of-order.delay', delay);
        this.monitor.measure(`${region}.cwe-out-of-order.delay`, delay);
        log.info({region, id, state}, 'CloudWatch Event delivered out of order');
      }
    } else if (state === 'pending' || state === 'running') {
      // For events which are pending or running but which aren't in the
      // instances table already we'll use the describeInstances table to look
      // up the information about them.  This is less efficient, but still
      // works great.  If we were to start using the on-demand 'runInstances'
      // ec2 api instead of requestSpotInstances, we could instead always use
      // the state database for this data
      let apiResponse;
      try {
        apiResponse = await this.runaws(this.ec2, 'describeInstances', {
          InstanceIds: [id],
        });
      } catch (err) {
        // We're ignoring this error because it might happen that it is only
        // delay in internal EC2 updates.  Given that, we're going to wait
        // until we've exhausted all redeliveries, which we do in the dead
        // letter queue handler
        if (err.code !== 'InvalidInstanceID.NotFound') {
          this.monitor.reportError(err);
        } else {
          this.monitor.count('global.api-lag', 1);
          this.monitor.count(`${region}.api-lag`, 1);
        }
        throw err;
      }

      // TODO: CRITICAL Skip things which have a keyname which does not match ours

      assert(Array.isArray(apiResponse.Reservations));
      assert(apiResponse.Reservations.length === 1);
      assert(Array.isArray(apiResponse.Reservations[0].Instances));
      assert(apiResponse.Reservations[0].Instances.length === 1);
      let instance = apiResponse.Reservations[0].Instances[0];

      let [provisionerId, workerType] = instance.KeyName.split(':');
      let instanceType = instance.InstanceType;
      let srid = instance.SpotInstanceRequestId || undefined;
      let az = instance.Placement.AvailabilityZone;
      let imageId = instance.ImageId;
      let launched = new Date(instance.LaunchTime);

      // We check for workertype being truthy because it's always possible that
      // this instance is one which is not in the provisioner/ec2-manager sphere
      // of knowledge at all and as such has no colons in its name.
      if (workerType && missingTags(instance)) {
        await this.tagger.tagResources({
          ids: [id],
          workerType: workerType,
          region: region,
        });
      }
      let opts = {
        workerType,
        region,
        az,
        instanceType,
        imageId,
        id,
        state,
        launched,
        srid,
        lastevent: generated,
      };

      if (workerType && provisionerId === this.provisionerId) {
        await this.state.upsertInstance(opts);
        opts.metadataSource = 'api';
        log.info(opts, 'CloudWatch Event resulting in insertion');
      } else {
        opts.metadataSource = 'api';
        log.debug(opts, 'Ignoring instance because it does not belong to this manager');
      }
    } else {
      // For those events which are for instances which aren't being tracked in
      // the database, we'll just blindly delete them.  This might have
      // overhead on the database, but it does ensure that they're definitely
      // removed from state.  The cost is likely a non-issue since the only way
      // to avoid the removal would be the much more costly EC2 api calls to
      // figure out metadata.  If we wanted to start tracking instance outcome,
      // we could do it here (and also in the dbResponse truthy clause above).
      await this.state.removeInstance({region, id});
      log.debug({region, id}, 'CloudWatch Event resulting in deletion');
    }
  }

  start() {
    assert(this.sqsQueue);
    this.sqsQueue.start();
  }
  
  stop() {
    assert(this.sqsQueue);
    this.sqsQueue.stop();
  }
}

class DeadCloudWatchEventListener extends events.EventEmitter {

  constructor({
    sqs,
    queueName = 'ec2-events',
    monitor,
    region,
  }) {
    super();

    // Store the list of regions in which we're operating
    assert(typeof region === 'string');
    this.region = region;

    // Store some basic configuration values
    assert(typeof queueName === 'string');
    this.queueName = queueName;

    // Set up all the AWS clients that we'll possibly need
    assert(sqs);
    this.sqs = sqs;

    assert(this.sqs.config.region === region);

    // Store the reference to the monitor instance
    this.monitor = monitor.prefix('cloud-watch-events');

    this.queueUrl = undefined;

    this.sqsQueue = undefined;
  }

  async init() {
    this.queueUrl = await sqslib.getQueueUrl({sqs: this.sqs, queueName: this.queueName});

    this.sqsQueue = new sqslib.QueueListener({
      sqs: this.sqs,
      queueUrl: this.queueUrl,
      decodeMessage: false,
      maxNumberOfMessages: 10,
      maxReceiveCount: 20,
      handler: async msg => {
        await this.__handler(msg);
      },
    });

    this.sqsQueue.on('error', (err, errType) => {
      // We probably want to bubble this up... maybe?
      //this.emit('error', err, errType);
      log.error({err, errType}, 'SQS Handler Error');
    });
  }

  // TODO: Maybe what we should do is store these instance ids in a table and
  // poll them to see when they do become available and insert them into the
  // database *then*
  async __handler(msg) {
    let errorMsg = [
      'UNTRACKED INSTANCE\n\n',
      'A CloudWatch Event message has failed.  This is likely because the',
      'EC2 API call to DescribeInstances did not return information.  While',
      'we do retry this a number of times, we eventually give up.  This instance',
      'should probably be killed or else deleted.',
    ].join(' ');

    errorMsg += '\nFailing message follows:\n\n';
    errorMsg += msg;

    this.monitor.reportError(new Error(errorMsg), 'info');
  }

  start() {
    assert(this.sqsQueue);
    this.sqsQueue.start();
  }
  
  stop() {
    assert(this.sqsQueue);
    this.sqsQueue.stop();
  }
}

async function initCloudWatchEventListener(opts) {
  let obj = new CloudWatchEventListener(opts);
  await obj.init();
  return obj;
}

async function initDeadCloudWatchEventListener(opts) {
  let obj = new DeadCloudWatchEventListener(opts);
  await obj.init();
  return obj;
}

module.exports = {
  initCloudWatchEventListener,
  initDeadCloudWatchEventListener,
  CloudWatchEventListener,
};
