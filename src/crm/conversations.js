const conversations = new Map()

function getConversation(phone){
  if(!conversations.has(phone)){
    conversations.set(phone,{
      step:"menu",
      name:"",
      cpf:"",
      course:"",
      payment:""
    })
  }

  return conversations.get(phone)
}

module.exports = {getConversation}
