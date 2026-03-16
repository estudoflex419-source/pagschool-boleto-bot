const axios = require("axios")
const {META_PHONE_ID,META_TOKEN} = require("../config")

async function sendText(phone,text){
  await axios.post(
    `https://graph.facebook.com/v19.0/${META_PHONE_ID}/messages`,
    {
      messaging_product:"whatsapp",
      to:phone,
      type:"text",
      text:{body:text}
    },
    {
      headers:{
        Authorization:`Bearer ${META_TOKEN}`
      }
    }
  )
}

module.exports={sendText}
