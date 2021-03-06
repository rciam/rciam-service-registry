require('dotenv').config();
const {petitionValidationRules,validate,tenantValidation,formatPetition,getServiceListValidation,postInvitationValidation,serviceValidationRules,putAgentValidation,postAgentValidation,decodeAms,amsIngestValidation,generateClientId,reFormatPetition} = require('../validator.js');
const {validationResult} = require('express-validator');
const qs = require('qs');
const {v1:uuidv1} = require('uuid');
const axios = require('axios').default;
const {merge_data,merge_services_and_petitions} = require('../merge_data.js');
const {addToString,clearPetitionData,sendMail,sendInvitationMail,sendMultipleInvitations} = require('../functions/helpers.js');
const {db} = require('../db');
var diff = require('deep-diff').diff;
var router = require('express').Router();
var passport = require('passport');
var config = require('../config');
const customLogger = require('../loggers.js');
const { generators } = require('openid-client');
const code_verifier = generators.codeVerifier();
const {rejectPetition,approvePetition,changesPetition,getPetition,getOpenPetition} = require('../controllers/main.js');
const base64url = require('base64url');



// ----------------------------------------------------------
// ************************* Routes *************************
// ----------------------------------------------------------

//
// router.get('/test',getData,serviceValidationRules({optional:false,tenant_param:false,check_available:true,sanitize:true}),(req,res,next)=>{
//
//
//     res.status(200).send(req.body);
//     const errors = validationResult(req);
//     console.log(errors);
// });

function getData(req,res,next) {
  db.service.getAll().then(services=>{
    req.body = services;
    next();
  });
}

router.post('/tenants/:tenant_name/services',tenantValidation(),validate,serviceValidationRules({optional:true,tenant_param:true,check_available:true,sanitize:true,null_client_id:false}),validate,(req,res,next)=> {
  let services = req.body;
  // Populate json objects with all necessary fields
  services.forEach((service,index) => {
    services[index].tenant = req.params.tenant_name

    config.service_fields.forEach(field=>{
      if(!service[field]){
        services[index][field] = null;
      }
    })
  })
  try{
    db.tx('addMultipleServices', async t => {
      await t.group.createMultiple(services).then(async ids=> {
        if(ids){
          services.forEach((service,index)=>{
            services[index].group_id = ids[index].id;
          });
          await t.service_details.addMultiple(services).then(async services =>{
            if(services){
              let contacts = [];
              let grant_types = [];
              let redirect_uris = [];
              let scopes = [];
              let queries = [];
              let service_state = [];
              let invitations = [];
              services.forEach((service,index)=> {
                service_state.push({id:service.id,state:'deployed',outdated:(service.outdated?true:false)});

                if(service.contacts && service.contacts.length>0){

                  service.contacts.forEach(contact=>{
                    if(contact.type==='technical'){
                      invitations.push({tenant:req.params.tenant_name,email:contact.email,group_manager:true,code:uuidv1(),group_id:service.group_id});
                    }
                    contacts.push({owner_id:service.id,value:contact.email,type:contact.type});
                  });
                }
                if(service.protocol==='oidc'){
                  if(service.grant_types && service.grant_types.length>0){
                    service.grant_types.forEach(grant_type => {
                      grant_types.push({owner_id:service.id,value:grant_type});
                    });
                  }
                  if(service.scope && service.scope.length>0){
                    service.scope.forEach(scope => {
                      scopes.push({owner_id:service.id,value:scope});
                    });
                  }
                  if(service.redirect_uris && service.redirect_uris.length>0){
                    service.redirect_uris.forEach(redirect_uri => {
                      redirect_uris.push({owner_id:service.id,value:redirect_uri});
                    });
                  }
                }
              });
              queries.push(t.service_state.addMultiple(service_state));
              queries.push(t.service_details_protocol.addMultiple(services));
              if(contacts.length>0){
                queries.push(t.service_contacts.addMultiple(contacts));
              }
              if(grant_types.length>0){
                queries.push(t.service_multi_valued.addMultiple(grant_types,'service_oidc_grant_types'));
              }
              if(scopes.length>0){
                queries.push(t.service_multi_valued.addMultiple(scopes,'service_oidc_scopes'));
              }
              if(redirect_uris.length>0){
                queries.push(t.service_multi_valued.addMultiple(redirect_uris,'service_oidc_redirect_uris'));
              }
              await t.batch(queries).then(done=>{
                if(done){
                  if(invitations.length>0){
                      sendMultipleInvitations(invitations,t);
                    }
                    res.status(200).end();
                  }

              }).catch(err=>{
                res.status(422).send(err);
              });
            }
          }).catch(err=>{console.log(err);});
        }
      }).catch(err => {console.log(err); throw err})
    }).catch(err => {console.log(err); throw err})

  }
  catch(err){
    next(err);
  }
});
// Get available tenats
router.get('/tenants/:tenant_name',(req,res,next)=>{
  try{
    db.tenants.getTheme(req.params.tenant_name).then(tenant=>{
      if(tenant){
        if(config.form[req.params.tenant_name]){
          tenant.form_config = config.form[req.params.tenant_name];
        }
        res.status(200).json(tenant).end();
      }
      else{
        res.status(404).end()
      }
    }).catch(err=>{throw err})
  }
  catch(err){
    next(err);
  }
});


router.get('/tenants',(req,res,next)=> {
  try{
    db.tenants.get().then(tenants => {
      if(tenants){
        res.status(200).json(tenants).end();
      }
      else {
        res.status(404).end()
      }
    })
  }
  catch(err){
    next(err);
  }
})

router.get('/tenants/:tenant_name/login',(req,res)=>{
  var clients = req.app.get('clients');
  if(clients[req.params.tenant_name]){
    res.redirect(clients[req.params.tenant_name].authorizationUrl({
      client_id:clients[req.params.tenant_name].client_id,
      scope: 'openid email profile eduperson_entitlement',
      redirect_uri: process.env.REDIRECT_URI+req.params.tenant_name
    }));
  }else{
    res.redirect(process.env.REACT_BASE+'/404');
  }
})

// Callback Route
router.get('/callback/:tenant_name',(req,res,next)=>{
  var clients = req.app.get('clients');
  clients[req.params.tenant_name].callback(process.env.REDIRECT_URI+req.params.tenant_name,{code:req.query.code}).then(async response => {
    let code = await db.tokens.addToken(response.access_token);
    clients[req.params.tenant_name].userinfo(response.access_token).then(usr_info=>{
      saveUser(usr_info,req.params.tenant_name);
    }); // => Promise
    res.redirect(process.env.REACT_BASE+'/'+req.params.tenant_name+'/code/' + code.code);
  });
});

// Route used for verifing push subscription
router.get('/ams/ams_verification_hash',(req,res)=>{
  console.log('ams verification');
  res.setHeader('Content-type', 'plain/text');
  res.status(200).send(process.env.AMS_VER_HASH);
})

// One time code to get access token during login
router.get('/tokens/:code',(req,res,next)=>{
  try{
    db.task('deploymentTasks', async t => {
      await t.tokens.getToken(req.params.code).then(async response=>{
        if(res){
          await t.tokens.deleteToken(req.params.code).then(deleted=>{
            if(deleted){
              res.status(200).json({token:response.token});
            }
          }).catch(err=>{next(err);})
        }
      }).catch(err=>{next(err);})
    })
  }
  catch(err){
    next(err)
  }
});

router.get('/tenants/:tenant_name/services/:id/error',authenticate,(req,res,next)=>{
  try{
    if(req.user.role.actions.includes('view_errors')){

      db.service_errors.getErrorByServiceId(req.params.id).then(response=>{
        if(response){
          return res.status(200).json({error:response});
        }
        else{
          return res.status(404).end();
        }
      });
    }
  }
  catch(err){
    next(err);
  }
});

router.put('/tenants/:tenant_name/services/:id/error',authenticate,(req,res,next)=> {
  try{
    if(req.user.role.actions.includes('view_errors')){
      if(req.query.action==='resend'){
        db.tx('accept-invite',async t =>{
              let done = await t.batch([
                t.service_state.resend(req.params.id),
                t.service_errors.archive(req.params.id),
              ]).catch(err=>{next(err)});
              res.status(200).end();
        }).catch(err=>{next(err)})
      }
    }
  }
  catch(err){
    next(err);
  }
})




// Get User User Info
router.get('/tenants/:tenant_name/user',authenticate,(req,res,next)=>{
  try{
    var clients = req.app.get('clients');
    TokenArray = req.headers.authorization.split(" ");
    clients[req.params.tenant_name].userinfo(TokenArray[1]) // => Promise
    .then(function (userinfo) {
      let user = userinfo;
      if(req.user.role.actions.includes('review_own_petition')){
        user.admin = true;
      }
      if(req.user.role.actions.includes('view_errors')){
        user.view_errors = true;
      }
      user.actions = req.user.role.actions;
      user.role = req.user.role.name;
      res.end(JSON.stringify({user}));
    }).catch(err=>{next(err)});
  }
  catch(err){
    next(err)
  }
});

// needs Authentication
// ams/ingest
router.post('/ams/ingest',checkCertificate,decodeAms,amsIngestValidation(),validate,(req,res,next)=>{
  // Decode messages
  try{
    return db.task('deploymentTasks', async t => {
      // update state
      await t.service_state.deploymentUpdate(req.body.decoded_messages).then(async ids=>{
        if(ids){
          res.status(200).end();
          if(ids.length>0){
            await t.user.getServiceOwners(ids).then(data=>{
              if(data){
                data.forEach(email_data=>{
                  sendMail({subject:'Service Deployment Result',service_name:email_data.service_name,state:email_data.state,tenant:email_data.tenant},'deployment-notification.html',[{name:email_data.name,email:email_data.email}]);
                });
              }
            }).catch(err=>{
              next('Could not sent deployment email.' + err);
            });
          }
        }
        else{
          next('Deployment Failed');
        }
      }).catch(err=>{
        res.status(200).send("Invalid Message");
      });
    });
  }
  catch(err){
    next(err);
  }
});


// ams-agent requests to set state to waiting development
// updateData = [{id:1,state:'deployed',tenant:'egi',protocol:'oidc'},{id:2,state:'deployed',tenant:'egi',protocol:'saml'},{id:3,state:'failed',tenant:'eosc',protocol:'oidc'}];
router.put('/agent/set_services_state',amsAgentAuth,(req,res,next)=>{
  try{
    return db.task('set_state_and_agents',async t=>{
      let service_pending_agents = [];
      await t.service_state.updateMultiple(req.body).then(async result=>{
        if(result){
          await t.deployer_agents.getAll().then(async agents => {
            if(agents){
              req.body.forEach(service=> {
                agents.forEach(agent => {
                  if(agent.tenant===service.tenant && agent.entity_protocol===service.protocol  && agent.entity_type==='service' && agent.integration_environment===service.integration_environment ){
                    service_pending_agents.push({agent_id:agent.id,service_id:service.id});
                  }
                })
              });
              console.log(service_pending_agents);
              await t.deployment_tasks.setDeploymentTasks(service_pending_agents).then(success=> {
                if(success){
                  res.status(200).end();
                }
                else{
                  next('Could not set pending deployers')
                }
              });
            }
            else{
              next('Failed to get deployer agents')
            }
          })
        }
        else{
          next('Failed to update state')
        }
      });
    });
  }
  catch(err){next(err);}
});

// Find all clients/petitions from curtain user to create preview list
router.get('/tenants/:tenant_name/services', getServiceListValidation(),validate,authenticate,(req,res,next)=>{
  try{
      if(req.user.role.actions.includes('get_services')&&req.user.role.actions.includes('get_petitions')){
        db.service_list.get(req).then(response =>{
            if(response.length===0){
              response.push({
                list_items : [],
                full_count : 0
              })

            }
            return res.status(200).send(response[0]);
        }).catch(err=>{
          console.log(err);
          return res.status(416).send('Out of range');
        });
      }
      else if(req.user.role.actions.includes('get_own_services')&&req.user.role.actions.includes('get_own_petitions')){
        req.query.owned=true;
        db.service_list.get(req).then(response =>{
          if(response.length===0){
            response.push({
              list_items : [],
              full_count : 0
            })
          }
          return res.status(200).send(response[0]);
        }).catch(err=>{
          console.log(err);
          return res.status(416).send('Out of range');
        });
      }
      else{
        res.status(401).json({err:'Requested action not authorised'})
      }
  }
  catch(err){
    next(err);
  }
});

// ams-agent requests
router.get('/agent/get_new_configurations',amsAgentAuth,(req,res,next)=>{
//router.get('/agent/get_new_configurations',(req,res,next)=>{
  try{
    db.service.getPending().then(services=>{
      if(services){
        res.status(200).json({services});
      }
    }).catch((err)=>{
      next(err);
    });
  }
  catch(err){
    next(err);
  }
})

// It returns a service with form data
router.get('/tenants/:tenant_name/services/:id',authenticate,(req,res,next)=>{
  if(req.user.role.actions.includes('get_own_service')){
    try{
      if(req.user.role.actions.includes('get_service')){
        db.service.get(req.params.id,req.params.tenant_name).then(result=>{
          if(result){
            res.status(200).json({service:result.service_data});
          }
          else {
            res.status(404).end();
          }
        }).catch(err=>{next(err);})
      }
      else{
        return db.task('find-service-data',async t=>{
          await t.service_details.getProtocol(req.params.id,req.user.sub,req.params.tenant_name).then(async exists=>{
            if(exists){
              await t.service.get(req.params.id,req.params.tenant_name).then(result=>{
                if(result){
                  res.status(200).json({service:result.service_data});
                }
                else {
                  res.status(404).end();
                }
              }).catch(err=>{next(err);})
            }
            else{
              res.status(404).end();
            }
          }).catch(err=>{next(err);});;
        });
      }
    }
    catch(err){
      next(err);
    }
  }
  else{
    res.status(401).json({err:'Requested action not authorised'})
  }
});

// Get all petitions linked to a service
router.get('/tenants/:tenant_name/services/:id/petitions',authenticate,(req,res)=>{

    try{
      return db.tx('get-history-for-petition', async t =>{
        if(req.user.role.actions.includes('get_petitions')){
          await t.service_petition_details.getHistory(req.params.id,req.params.tenant_name).then(petition_list =>{
            return res.status(200).json({history:petition_list});
          }).catch(err=>{next(err)});
        }
        else if(req.user.role.actions.includes('get_own_petitions')){
          await t.service_details.getProtocol(req.params.id,req.user.sub,req.params.tenant_name).then(async service=>{
            if(service){
              await t.service_petition_details.getHistory(req.params.id,req.params.tenant_name).then(petition_list =>{
                return res.status(200).json({history:petition_list});
              }).catch(err=>{next(err)});
            }
          }).catch(err =>{next(err)});
        }
        else {
          res.status(401).json({err:'Requested action not authorised'});
        }

      });
    }
    catch(e){
      next(e);
    }


});

// Get target petition
router.get('/tenants/:tenant_name/petitions/:id',authenticate,(req,res,next)=>{
  try{
    if(req.query.type==='open'){
      getOpenPetition(req,res,next,db);
    }
    else{
      getPetition(req,res,next,db);
    }
  }
  catch(err){
    next(err);
  }
});

// Add a new client/petition
router.post('/tenants/:tenant_name/petitions',authenticate,petitionValidationRules(),validate,formatPetition,serviceValidationRules({optional:false,tenant_param:true,check_available:false,sanitize:false,null_client_id:true}),validate,reFormatPetition,asyncPetitionValidation,(req,res,next)=>{

  res.setHeader('Content-Type', 'application/json');
  if(req.user.role.actions.includes('add_own_petition')){
    try{
      db.tx('add-service', async t => {
        if(req.body.type==='delete'){
          await t.service.get(req.body.service_id,req.params.tenant_name).then(async service => {
            if (service) {
              service = service.service_data;
              service.service_id = req.body.service_id;
              service.type = 'delete';
              service.tenant = req.params.tenant_name;
              await t.petition.add(service,req.user.sub).then(id=>{
                if(id){
                  res.status(200).json({id:id});
                }
                else{
                  //  throw warning
                }
              }).catch(err=>{next(err)});
            }
          }).catch(err=>{next(err)});
        }
        else{
          req.body.tenant = req.params.tenant_name;
          await t.petition.add(req.body,req.user.sub).then(async id=>{
            if(id){
              res.status(200).json({id:id});
              await t.user.getReviewers(req.params.tenant_name).then(users=>{
                sendMail({subject:'New Petition to Review',service_name:req.body.service_name,tenant:req.params.tenant_name},'reviewer-notification.html',users);
              }).catch(error=>{
                next('Could not sent email to reviewers:' + error);
              });
            }
          }).catch(err=>{next(err)});
        }
      });
    }
    catch(err){
      res.status(500).json({error:'Error querying the database.'});
      next(err);
    }
  }
  else{
    res.status(401).json({err:'Requested action not authorised'})
  }
});

// Delete Petition
router.delete('/tenants/:tenant_name/petitions/:id',authenticate,(req,res,next)=>{
  if(req.user.role.actions.includes('delete_own_petition')){
    return db.tx('delete-petition',async t =>{
      try{
        await t.service_petition_details.belongsToRequester(req.params.id,req.user.sub,req.params.tenant_name).then(async belongs =>{
          if(belongs){
            const deleted = await t.service_petition_details.deletePetition(req.params.id);
            if(deleted){
              return res.status(200).end();
            }
            else{
              next('Cant delete Petition');
            }

          }
          else{
            next('Cannot find petition');
          }
        }).catch(err=>{next(err);})
      }
      catch(error){
        next(err);
      }
    });
  }
  else{
    res.status(401).json({err:'Requested action not authorised'})
  }
});

// Edit Petition
router.put('/tenants/:tenant_name/petitions/:id',authenticate,petitionValidationRules(),validate,formatPetition,serviceValidationRules({optional:false,tenant_param:true,check_available:false,sanitize:false,null_client_id:true}),validate,reFormatPetition,asyncPetitionValidation,(req,res,next)=>{
  if(req.user.role.actions.includes('update_own_petition')){
    return db.task('update-petition',async t =>{
      try{
        if(req.body.type==='delete'){
          await t.service.get(req.body.service_id,req.params.tenant_name).then(async service => {
            if (service) {
              service = service.service_data;
              service.service_id = req.body.service_id;
              service.type = 'delete';
              await t.petition.update(service,req.params.id,req.params.tenant_name).then(resp=>{
                if(resp.success){
                  res.status(200).json();
                }
                else{
                  //  throw warning
                }
              }).catch(err=>{next(err)});
            }
          }).catch(err=>{next(err)});
        }
        else{
          await t.petition.update(req.body,req.params.id,req.params.tenant_name).then(response=>{
            if(response.success){
              res.status(200).end();
            }
            else{
              if(response.error){
                next(response.error);
              }
            }
          }).catch(err=>{next(err)});
        }
      }
      catch(err){
        next(err);
      }
    })
  }
  else{
    res.status(401).json({err:'Requested action not authorised'})
  }
});

// Admin rejects petition
router.put('/tenants/:tenant_name/petitions/:id/review',authenticate,canReview,(req,res,next)=>{
  try{
    if(req.body.type==='reject'){
      rejectPetition(req,res,next,db);
    }
    else if(req.body.type==='approve'){
      approvePetition(req,res,next,db);
    }
    else if(req.body.type==='changes'){
      changesPetition(req,res,next,db);
    }
    else{
      throw 'Invalid review type'
    }
  }
  catch(err){
    next(err);
  }
});

// Check availability for protocol unique id
router.get('/tenants/:tenant_name/check-availability',(req,res,next)=>{
  db.tx('get-history-for-petition', async t =>{
    try{
      await isAvailable(t,req.query.value,req.query.protocol,0,0,req.params.tenant_name,req.query.environment).then(available =>{
            res.status(200).json({available:available});
      }).catch(err=>{next(err)});
    }
    catch(err){
      next(err);
    }
  });
});



// -------------------------------------------------------------------------
// ----------------------Groups and Invitations-----------------------------
// -------------------------------------------------------------------------

// Get group members
router.get('/tenants/:tenant_name/groups/:group_id/members',authenticate,view_group,(req,res,next)=>{
  try{
    db.group.getMembers(req.params.group_id).then(group_members =>{
      if(group_members){
        res.status(200).json({group_members});
      }
      else{
        res.status(404).end();
      }
    })
  }
  catch(err){next(err);}
})

// Remove member from group
router.delete('/tenants/:tenant_name/groups/:group_id/members/:sub',authenticate,is_group_manager,(req,res,next)=>{
  try{
    db.group.deleteSub(req.params.sub,req.params.group_id).then(response=>{
      if(response){
        res.status(200).end();
      }
      else{
        res.status(204).end();
      }
    }).catch(err=>{next(err)})
  }
  catch(err){
    next(err);
  }
})

// Create invitation and send email
router.post('/tenants/:tenant_name/groups/:group_id/invitations',authenticate,postInvitationValidation(),validate,canInvite, (req,res,next)=>{
  try{
    req.body.code = uuidv1();
    req.body.invited_by = req.user.email;
    req.body.tenant = req.params.tenant_name;

    // Send invitation to requested email
    sendInvitationMail(req.body).then(async email_sent=>{
      if(email_sent){
        // Email is sent succesfully
        // Save invitation to database
        await db.invitation.add(req.body).then((response)=>{
          if(response){
            res.status(200).send({code:req.body.code});
          }
          else{
            res.status(204).end();
          }
        }).catch(err=>{next(err)})
      }
      else{
        throw 'could not send invitation message'
      }
    }).catch(err => {next(err)});

  }
  catch(err){
    next(err);
  }
});

// Delete invitation
router.delete('/tenants/:tenant_name/groups/:group_id/invitations/:id',authenticate,canInvite,(req,res,next)=>{
  try{
    db.invitation.delete(req.params.id).then(response=>{
      if(response){
        res.status(200).end();
      }
      else{
        res.status(204).end();
      }
    }).catch(err=>{next(err);})
  }
  catch(err){
      next(err);
  }
});

// Refresh invitation
router.put('/tenants/:tenant_name/groups/:group_id/invitations/:id',authenticate,canInvite,(req,res,next)=>{
  try{
    db.invitation.refresh(req.params.id).then(response=>{
      if(response.code){
        response.tenant = req.params.tenant_name;
        sendInvitationMail(response)
        res.status(200).end();
      }
      else{
        res.status(204).end();
      }
    }).catch(err=>{next(err);})
  }
  catch(err){
      next(err);
  }
});

// Accept/Reject invitation

router.put('/tenants/:tenant_name/invitations/:invite_id/:action',authenticate,(req,res,next)=>{
  try{
    if(req.params.action==='accept'){
      db.tx('accept-invite',async t =>{
        await t.invitation.getOne(req.params.invite_id,req.user.sub).then(async invitation_data=>{
          if(invitation_data){
            invitation_data.tenant = req.params.tenant_name;
            let done = await t.batch([
              t.group.newMemberNotification(invitation_data),
              t.group.addMember(invitation_data),
              t.invitation.reject(req.params.invite_id,req.user.sub)
            ]).catch(err=>{next(err)});
            res.status(200).end();
          }
          else{
            res.status(204).send("No invitation was found");
          }
        }).catch(err=>{next(err)})
      })
    }
    else if(req.params.action==='decline'){
      db.invitation.reject(req.params.invite_id,req.user.sub).then(response=>{
        if(response){
          res.status(200).end();
        }
        else{
          res.status(204).end();
        }
      }).catch(err=>{next(err);})
    }
    else{
      throw 'Invalid invitation response type';
    }
  }
  catch(err){
    next(err);
  }
})

// Get all invitations for requesting user
router.get('/tenants/:tenant_name/invitations',authenticate,(req,res,next)=>{
  try{
    db.invitation.getAll(req.user.sub).then((response)=>{
      if(response){
        res.status(200).json(response);
      }
      else{
        res.status(404).end()
      }
    }).catch(err=>{next(err)})
  }
  catch(err){
    next(err);
  }
});

// Get all invitations for a specific
router.get('/tenants/:tenant_name/groups/:group_id/invitations',authenticate,(req,res,next)=>{
  try{
    db.invitation.get(req.params.group_id).then(invitations => {
      if(invitations){
        res.status(200).json({invitations});
      }
      else{
        res.status(404).end();
      }
    })
  }
  catch(err){
    next(err)
  }
})

// Activate invitation
router.put('/tenants/:tenant_name/invitations/activate_by_code',authenticate,(req,res,next)=>{
  try{
    db.invitation.setUser(req.body.code,req.user.sub).then(result=>{
      if(result.success){
        res.status(200).json({id:result.id});
      }
      else if (result.error) {
        res.status(406).json({error:result.error});
      }
      else {
        res.status(404).end();
      }
    }).catch(err=>{next(err)})
  }
  catch(err){
    next(err);
  }
})

// Tenants Deployer Agents
router.get('/agent/get_agents',amsAgentAuth,(req,res,next)=>{
  try{
    db.deployer_agents.getAll().then(result => {
      if(result){
        res.status(200).json({agents:result});
      }
      else{
        res.status(404).send('No agents found.')
      }
    })
  }
  catch(err){
    next(err);
  }
});

router.get('/tenants/:tenant_name/agents',(req,res,next)=>{
  try{
    db.deployer_agents.getTenantsAgents(req.params.tenant_name).then(result => {
      if(result){
        res.status(200).json({agents:result});
      }
      else{
        res.status(404).send('No agents found.')
      }
    })
  }
  catch(err){
    next(err);
  }
});

router.get('/tenants/:tenant_name/agents/:id',(req,res,next)=>{
  try{
    db.deployer_agents.getById(req.params.tenant_name,req.params.id).then(async result => {
      if(result){
        res.status(200).send(result);
      }
      else{
        res.status(404).send('No agent found')
      }
    })
  }
  catch(err){
    next(err);
  }
});

router.put('/tenants/:tenant_name/agents/:id',putAgentValidation(),validate,(req,res,next)=>{
  try{
    db.deployer_agents.update(req.body,req.params.id,req.params.tenant_name).then(result => {
      if(result){
        res.status(200).end();
      }
      else{
        res.status(404).send('Could not find agent')
      }
    })
  }
  catch(err){
    next(err);
  }
});
router.post('/tenants/:tenant_name/agents',postAgentValidation(),validate,(req,res,next)=>{
  try{
    db.deployer_agents.add(req.body.agents,req.params.tenant_name).then(async result => {
      if(result){
        res.status(200).end();
      }
      else{
        res.status(404).send('Could not add agents')
      }
    })
  }
  catch(err){
    next(err);
  }
});

router.delete('/tenants/:tenant_name/agents',(req,res,next)=>{
  try{
    db.deployer_agents.deleteAll(req.params.tenant_name).then(result => {
      if(result){
        res.status(200).end();
      }
      else{
        res.status(404).send('No agents where found to delete');
      }
    })
  }
  catch(err){
    next(err);
  }

});
router.delete('/tenants/:tenant_name/agents/:id',(req,res,next)=>{
  try{
    db.deployer_agents.delete(req.params.tenant_name,req.params.id).then(result => {
      if(result){
        res.status(200).end();
      }
      else{
        res.status(404).send('No agent was found');
      }
    })
  }
  catch(err){
    next(err);
  }
});


// ----------------------------------------------------------
// ******************** HELPER FUNCTIONS ********************
// ----------------------------------------------------------


function is_group_manager(req,res,next){

  try{
    req.body.group_id=req.params.group_id;
    db.group.isGroupManager(req.user.sub,req.body.group_id).then(result=>{
      if(result){
        next();
      }
      else{
        res.status(406).send({error:"Can't access this resource"});
      }
    }).catch(err=>{next(err)});
  }
  catch(err){
    next(err);
  }
}

function canInvite(req,res,next){

  try{
    req.body.group_id=req.params.group_id;
    if(req.user.role.actions.includes('invite_to_group')){
      next()
    }
    else{
      db.group.isGroupManager(req.user.sub,req.body.group_id).then(result=>{
        if(result){
          next();
        }
        else{
          res.status(406).send({error:"Can't access this resource"});
        }
      }).catch(err=>{next(err)});
    }
  }
  catch(err){
    next(err);
  }
}


function view_group(req,res,next){
  try{
    if(req.user.role.actions.includes('view_groups')){
      next();
    }
    else{
      db.group.isGroupMember(req.user.sub,req.params.group_id).then(result=>{
        if(result){
          next();
        }
        else{
          throw "Can't access this resource";
        }
      }).catch(err=>{next(err)});
    }
  }
  catch(err){
      next(err);
  }
}


function decode(jwt) {
    const [headerB64, payloadB64] = jwt.split('.');
    const payloadStr = JSON.parse(base64url.decode(payloadB64));
    return payloadStr.user;
}


// Authentication Middleware
function authenticate(req,res,next){
  try{
    var clients = req.app.get('clients');
    if(process.env.NODE_ENV==='test-docker'||process.env.NODE_ENV==='test'){
      let token = req.headers['x-access-token'] || req.headers['authorization']; // Express headers are auto converted to lowercase
      if (token && token.startsWith('Bearer ')) {
        // Remove Bearer from string
        token = token.slice(7, token.length);
        req.user = decode(token);
        db.user_role.getRoleActions(req.user.edu_person_entitlement,req.params.tenant_name).then(role=>{
          if(role.success){
            req.user.role = role.role;
            next();
          }else{
            res.status(401).send('Unauthenticated Request');
          }
        }).catch(err=>{
          next(err)});
      }
      else{
        res.status(500).send("Need userToken");
      }
    }
    else{
      const data = {'client_secret':clients[req.params.tenant_name].client_secret}
      if(req.headers.authorization){
        TokenArray = req.headers.authorization.split(" ");
        axios({
          method:'post',
          url: clients[req.params.tenant_name].issuer_url+'introspect',
          params: {
            client_id:clients[req.params.tenant_name].client_id,
            token:TokenArray[1]
          },
          headers: {
            'Content-Type':'application/x-www-form-urlencoded',
            'Accept': 'application/json'
          },
          data: qs.stringify(data)
        }).then(result => {
          //console.log(result);
          req.user = {};
          req.user.sub = result.data.sub;

          req.user.edu_person_entitlement = result.data.eduperson_entitlement;
          req.user.iss = result.data.iss;
          req.user.email = result.data.email;
          if(req.user.sub){
            db.user_role.getRoleActions(req.user.edu_person_entitlement,req.params.tenant_name).then(role=>{
              if(role.success){
                req.user.role = role.role;
                console.log('User with email ' + result.data.email + ' is authenticated');
                //console.log('authenticated');
                next();
              }
              else{

                res.status(401).end();
              }
            }).catch((err)=> {
              customLogger(req,res,'warn','Unauthenticated request'+err);

              res.status(401).end();
            });
          }
          else{res.status(401).end();}
        }, (error) =>{
          customLogger(req,res,'warn','Unauthenticated request'+ error);
          res.status(401).end();
        }).catch(err=>{res.status(401).end();})
      }
      else{
        res.status(401).end();
      }
    }

  }
  catch(err){
    customLogger(req,res,'warn','Unauthenticated request'+err);
    next(err);
  }

}

// Authenticating AmsAgent
function amsAgentAuth(req,res,next){
  if(req.header('X-Api-Key')===process.env.AMS_AGENT_KEY){
    next();
  }
  else{
    res.status(401)
    customLogger(req,res,'warn','Unauthenticated request');
    res.json({success:false,error:'Authentication failure'})
  }
}


// Checking Review Permitions
function canReview(req,res,next){
  if(req.user.role.actions.includes('review_petition')){
    next();
  }
  else{
    db.petition.canReviewOwn(req.params.id,req.user.sub).then(service=>{

      if(service&&service.integration_environment==='development'){
        next();
      }
      else if(service){
         if (req.user.role.actions.includes('review_own_petition')){
           next();
         }
         else{
            res.status(401).json({error:'Requested action not authorised'});
         }
      }
      else{
        res.status(401).json({error:'Requested action not authorised'});
      }
    })
  }

}

// Save new User to db. Gets called on Authentication
const saveUser=(userinfo,tenant)=>{
  return db.tx('user-check',async t=>{
    return t.user_info.findBySub(userinfo.sub,tenant).then(async user=>{
      if(!user) {
        return t.user_info.add(userinfo,tenant).then(async result=>{
          if(result){
              return t.user_edu_person_entitlement.add(userinfo.eduperson_entitlement,result.id);
          }
        });
      }
    })

  });
}

function checkCertificate(req,res,next) {
  if(req.headers['authorization']===process.env.AMS_AUTH_KEY){
    next();
  }
  else{
    res.status(401).send('Client Certificate Authentication Failure');
  }
}

// Checking Availability of Client Id/Entity Id
const isAvailable= async (t,id,protocol,petition_id,service_id,tenant,environment)=>{
  if(id){
    if(protocol==='oidc'){
      return t.service_details_protocol.checkClientId(id,service_id,petition_id,tenant,environment);
    }
    else if (protocol==='saml'){
      return t.service_details_protocol.checkEntityId(id,service_id,petition_id,tenant,environment);
    }
  }
  else {
    return true;
  }
}

// This validation is for the POST,PUT /petition
function asyncPetitionValidation(req,res,next){
  // for all petitions we need to check for Client Id/Entity Id availability
  try{
    return db.tx('user-check',async t=>{
      // For the post
      if(req.route.methods.post){
        if(req.body.type==='create'){
          await isAvailable.apply(this,(req.body.protocol==='oidc'?[t,req.body.client_id,'oidc',0,0,req.params.tenant_name,req.body.integration_environment]:[t,req.body.entity_id,'saml',0,0,req.params.tenant_name,req.body.integration_environment])).then(async available=>{
            if(available){

              next();
            }
            else {
              res.status(422);
              customLogger(req,res,'warn','Protocol id is not available');
              return res.end();};
          });
        }
        else{
          // Here we handle petitons of edit and delete type
          // First we need to make sure there aren't any open petitions for target service
          await t.service_petition_details.openPetition(req.body.service_id,req.params.tenant_name).then(async open_petition_id =>{
            if(!open_petition_id){
              await t.service_details.getProtocol(req.body.service_id,req.user.sub,req.params.tenant_name).then(async service =>{
                if(service&&service.protocol){
                  if(req.body.type==='delete'){

                    next();
                  }
                  else if(service.protocol===req.body.protocol){
                    await isAvailable.apply(this,(req.body.protocol==='oidc'?[t,req.body.client_id,'oidc',0,req.body.service_id,req.params.tenant_name,req.body.integration_environment]:[t,req.body.entity_id,'saml',0,req.body.service_id,req.params.tenant_name,req.body.integration_environment])).then(async available=>{
                      if(available){
                        next();
                      }
                      else {
                        res.status(422).send({error:'Protocol id is not available'});;
                        customLogger(req,res,'warn','Protocol id is not available');
                        return res.end();
                      }
                    });
                  }
                  else{
                    res.status(403).send({error:'Tried to edit protocol'});;
                    customLogger(req,res,'warn','Tried to edit protocol.');
                    return res.end();
                  }
                }
                else {
                  res.status(403).send({error:'Could not find petition with id: '+req.body.service_id});;
                  customLogger(req,res,'warn','Could not find service with id:'+req.body.service_id);
                  return res.end();
                }
              });
            }
            else {
              res.status(403).send({error:'Cannot create new petition because there is an open petition existing for target service'});
              customLogger(req,res,'warn','Cannot create new petition because there is an open petition existing for target service');
              return res.end();
            }
          });
        }
      }
      else if(req.route.methods.put){
        await t.service_petition_details.belongsToRequester(req.params.id,req.user.sub,req.params.tenant_name).then(async petition => {
          if(petition){
            if(req.body.type==='delete'){
              next();
            }
            else{
              if(petition.protocol!==req.body.protocol){
                customLogger(req,res,'warn','Tried to edit protocol.');
                return res.status(403).send({error:'Tried to edit protocol'});
              }
              if(petition.type==='create' && req.body.type!=='create'){
                customLogger(req,res,'warn','Tried to edit registration type');
                return res.status(403).send({error:'Tried to edit registration type'});
              }
              if(!req.body.service_id){
                req.body.service_id=0;
              }
              await isAvailable.apply(this,(req.body.protocol==='oidc'?[t,req.body.client_id,'oidc',req.params.id,req.body.service_id,req.params.tenant_name,req.body.integration_environment]:[t,req.body.entity_id,'saml',req.params.id,req.body.service_id,req.params.tenant_name,req.body.integration_environment])).then(async available=>{
                if(available){
                  next();
                }
                else{
                  customLogger(req,res,'warn','Protocol id is not available');
                  res.status(422).send({error:'Protocol id is not available'});
                }
              });
            }
          }
          else{
            res.status(403).send({error:'Could not find petition with id: '+req.params.id});
            customLogger(req,res,'warn','Could not find petition with id: '+req.params.id);
            return res.end();
          }
        }).catch(err=>{next(err);});;
      }
    })
  }
  catch(err){
    next(err)
  }
}







module.exports = {
  router:router
}
