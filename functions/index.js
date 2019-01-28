'use strict';

const fetch = require('node-fetch');
const functions = require('firebase-functions');
const { smarthome } = require('actions-on-google');
const util = require('util');
const admin = require('firebase-admin');
admin.initializeApp();

const firebaseRef = admin.database().ref('/');

const agentUserId = '23213213131321321321';

exports.auth = functions.https.onRequest((request, response) => {
  const responseurl = util.format(
    '%s?code=%s&state=%s',
    decodeURIComponent(request.query.redirect_uri),
    'xxxxxx',
    request.query.state
  );
  console.log(responseurl);
  return response.redirect(responseurl);
});

exports.token = functions.https.onRequest((request, response) => {
  const grantType = request.query.grant_type
    ? request.query.grant_type
    : request.body.grant_type;
  const secondsInDay = 86400; // 60 * 60 * 24
  const HTTP_STATUS_OK = 200;
  console.log(`Grant type ${grantType}`);

  let obj;
  if (grantType === 'authorization_code') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      refresh_token: '123refresh',
      expires_in: secondsInDay
    };
  } else if (grantType === 'refresh_token') {
    obj = {
      token_type: 'bearer',
      access_token: '123access',
      expires_in: secondsInDay
    };
  }
  response.status(HTTP_STATUS_OK).json(obj);
});

let jwt;
try {
  jwt = require('./key.json');
} catch (e) {
  console.warn('Service account key is not found');
  console.warn('Report state will be unavailable');
}

const queryFirebase = deviceId =>
  firebaseRef
    .child(deviceId)
    .once('value')
    .then(snapshot => {
      const snapshotVal = snapshot.val();
      return {
        on: snapshotVal.on,
        online: snapshotVal.online,
      };
    });

const queryDevice = deviceId =>
  queryFirebase(deviceId).then(data => ({
    on: data.on
  }));

const app = smarthome({
  debug: true,
  key: jwt.key,
  jwt: jwt
});

app.onSync((body, headers) => {
  return {
    requestId: body.requestId,
    payload: {
      agentUserId,
      devices: [
        {
          id: 'standing-desk-123',
          type: 'action.devices.types.SWITCH',
          traits: ['action.devices.traits.OnOff'],
          name: {
            defaultNames: ['My Standing Desk'],
            name: 'Standing Desk',
            nicknames: ['Standing Desk']
          },
          deviceInfo: {
            manufacturer: 'Wassim Chegham',
            model: '123456789',
            hwVersion: '1.0',
            swVersion: '1.0'
          }
        }
      ]
    }
  };
});

app.onQuery(body => {
  const { requestId } = body;
  const device = body.inputs.pop().payload.devices.pop();
  const deviceId = device.id;

  return queryDevice(deviceId).then(data => {
    return {
      requestId,
      payload: {
        devices: {
          [deviceId]: data
        }
      }
    };
  });
});

app.onExecute((body, headers) => {
  const { requestId } = body;
  const commands = body.inputs.pop().payload.commands;
  const command = commands.pop();
  const device = command.devices.pop();
  const deviceId = device.id;
  const exec = command.execution.pop();
  const { params } = exec;

  console.log(body);

  firebaseRef
    .child(deviceId)
    .child('state')
    .update({
      on: params.on
    });

  return {
    requestId,
    payload: {
      commands: [
        {
          ids: [deviceId],
          status: 'SUCCESS',
          states: {
            online: true
          }
        }
      ]
    }
  };
});

app.onDisconnect((body, headers) => {
  return {};
});

exports.smarthome = functions.https.onRequest(app);

exports.requestsync = functions.https.onRequest((request, response) => {
  return app.requestSync(agentUserId)
  .then((res) => {
    console.log('Request sync was successful', res);
  })
  .catch((res) => {
    console.error('Request sync failed', res);
  });
});

/**
 * Send a REPORT STATE call to the homegraph when data for any device id
 * has been changed.
 */
exports.reportstate = functions.database.ref('{deviceId}/state').onWrite(event => {
  console.info('Firebase write event triggered this cloud function');
  if (!app.jwt) {
    console.warn('Service account key is not configured');
    console.warn('Report state is unavailable');
    return;
  }
  const snapshotVal = event.after.val();
  console.log('snapshotVal', snapshotVal);
  const mode = snapshotVal.on == true ? '3' : '1';

  return fetch(`https://wassimchegham.ngrok.io/mode/${mode}`)
    .then(res => {
      console.log(res.ok, res.status, res.statusText, res.headers.raw(), res.headers.get('content-type'));
      return res;
    })
    .then(res => (res.status == '404' ? null : res.json()))
    .then(json => {
      if (json) {
        return {
          requestId: 'xxxxxxxxxx',
          agentUserId,
          payload: {
            devices: {
              states: {
                [event.params.deviceId]: {
                  on: snapshotVal.on
                }
              }
            }
          }
        };
      } else {
        throw new Error('deviceOffline');
      }
    })
    .then(postData => app.reportState(postData))
    .then(data => {
      console.log('Report state came back');
      console.info(data);
    })
    .catch((res) => {
      return {
        requestId: 'xxxxxxxxxx',
        agentUserId,
        payload: {
          errorCode: 'deviceOffline'
        }
      };
    });
});
