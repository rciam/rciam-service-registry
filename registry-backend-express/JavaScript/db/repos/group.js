const sql = require('../sql').group;
const cs = {};

class GroupRepository {
  constructor(db, pgp) {
      this.db = db;
      this.pgp = pgp;
  }
  async getMembers(group_id){
    return this.db.any(sql.getGroupMembers,{group_id: +group_id}).then(res => {return res});
  }

  async addGroup(sub){
    return this.db.one('INSERT INTO groups(group_name) VALUES($1) RETURNING id',sub).then(async res =>{
      if(res){
        return await this.db.one('INSERT INTO group_subs(group_id,sub,group_manager) VALUES($1,$2,true) RETURNING group_id',[+res.id,sub]).then(res=>{
          if(res){
            return res.group_id
          }
        })
      }
    })
  }

  async deleteToken(code){
    return this.db.one('DELETE FROM tokens WHERE code=$1 RETURNING code',code);
  }
  async addToken(token){
    let code = uuidv1();
    return this.db.one('INSERT INTO tokens(code,token) VALUES ($1,$2) RETURNING code',[code,token]);
  }
}



module.exports = GroupRepository;