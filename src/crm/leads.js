const leads = new Map()

function saveLead(phone,data){
  leads.set(phone,{
    ...data,
    updated: new Date()
  })
}

function getLead(phone){
  return leads.get(phone)
}

module.exports = {saveLead,getLead}
