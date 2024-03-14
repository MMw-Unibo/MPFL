/*
 * Copyright IBM Corp. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict';

const Federated = require('./lib/federated').Federated;
module.exports.Federated = Federated;
module.exports.contracts = [Federated];