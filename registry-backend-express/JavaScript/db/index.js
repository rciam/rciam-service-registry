const promise = require('bluebird'); // best promise library today
const pgPromise = require('pg-promise'); // pg-promise core library
const dbConfig = require('../../db-config.json'); // db connection details
const {Diagnostics} = require('./diagnostics'); // optional diagnostics
const {ClientServices,ClientGeneral,UserInfo,UserEduPersonEntitlement,ClientContact,ClientPetitions} = require('./repos');

// pg-promise initialization options:
const initOptions = {

    // Use a custom promise library, instead of the default ES6 Promise:
    promiseLib: promise,

    // Extending the database protocol with our custom repositories;
    // API: http://vitaly-t.github.io/pg-promise/global.html#event:extend
    extend(obj, dc) {
        // Database Context (dc) is mainly useful when extending multiple databases with different access API-s.
        obj.client_services = new ClientServices(obj,pgp);
        obj.client_petitions = new ClientPetitions(obj,pgp);
        obj.user_info = new UserInfo(obj,pgp);
        obj.user_edu_person_entitlement = new UserEduPersonEntitlement(obj,pgp);
        obj.client_general = new ClientGeneral(obj,pgp);
        obj.client_contact = new ClientContact(obj,pgp);
        // Do not use 'require()' here, because this event occurs for every task and transaction being executed,
        // which should be as fast as possible.

    }
};

// Initializing the library:
const pgp = pgPromise(initOptions);

// Creating the database instance:
const db = pgp(dbConfig);

// Initializing optional diagnostics:
Diagnostics.init(initOptions);

// Alternatively, you can get access to pgp via db.$config.pgp
// See: https://vitaly-t.github.io/pg-promise/Database.html#$config
module.exports = {db, pgp};