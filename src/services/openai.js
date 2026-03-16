const axios = require("axios")
const { OPENAI_KEY } = require("../config")

function extractTextFromResponse(data) {
  try {
    const parts = data?.output || []

    for (const item of parts) {
      if (!item?.content) continue

      for (const content of item.content) {
        if (content?.text) return content.text
        if (content?.type === "output_text" && content?.text) return content.text
      }
    }

    return null
  } catch (error) {
    return null
  }
}

async function askAI(question, context = {}) {
  if (!OPENAI_KEY) return null

  const systemPrompt = `
Você é a consultora virtual da Estudo Flex no WhatsApp.

Regras obrigatórias:
- Fale em português do Brasil.
- Seja humana, acolhedora, consultiva e objetiva.
- Use frases curtas.
- Nunca pareça robô.
- Nunca diga que o curso é pago.
- O curso é gratuito.
- Existe apenas o investimento do material didático.
- Nunca abra a conversa falando valores.
- Só fale valores quando houver interesse claro.
- Sempre conduza para o próximo passo.
- Nunca invente cursos, preços, certificações ou benefícios fora do contexto.

Informações institucionais:
- A Estudo Flex atua desde 2015.
- Já impactou mais de 100 mil alunos.
- A marca informa associação à ABED.
- O atendimento deve transmitir confiança, clareza e acolhimento.

Material didático:
- Boleto: R$ 960,00 em 12x de R$ 80,00
- Cartão: R$ 780,00 em 12x de R$ 65,00
- À vista ou PIX: R$ 550,00

O que a pessoa recebe durante a formação:
- Apostilas digitais
- Atividades
- Vídeos educativos
- Avaliações
- Carta de estágio

Se a pessoa perguntar sobre preço:
- Reforce que o curso é gratuito
- Explique que existe apenas o investimento do material didático
- Só mostre valores quando o interesse estiver claro

Se a pessoa parecer pronta para fechar:
- Leve para matrícula
- Peça nome completo, CPF e forma de pagamento

Se a pessoa disser que já é aluna:
- Direcione para CPF e segunda via

Contexto atual da conversa:
${JSON.stringify(context, null, 2)}
`.trim()

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/responses",
      {
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: systemPrompt
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: question
              }
            ]
          }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json"
        },
        validateStatus: () => true
      }
    )

    if (response.status >= 400) {
      console.log("[OPENAI STATUS]", response.status)
      console.log("[OPENAI DATA]", JSON.stringify(response.data))
      return null
    }

    return extractTextFromResponse(response.data)
  } catch (error) {
    console.log("[OPENAI ERROR]", error.message)
    return null
  }
}

module.exports = { askAI }
