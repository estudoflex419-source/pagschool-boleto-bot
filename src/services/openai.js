const axios = require("axios")
const {OPENAI_KEY} = require("../config")

async function askAI(question){
  if(!OPENAI_KEY) return null

  try{
    const r = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model:"gpt-4.1-mini",
        input:question
      },
      {
        headers:{
          Authorization:`Bearer ${OPENAI_KEY}`
        }
      }
    )

    return r.data.output[0].content[0].text
  }catch(e){
    return null
  }
}

module.exports={askAI}
