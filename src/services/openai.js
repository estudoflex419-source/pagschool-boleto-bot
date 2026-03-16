const axios = require("axios")
const { OPENAI_KEY } = require("../config")

function extractText(data) {
  try {
    const output = data?.output || []

    for (const item of output) {
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
Você é a consultora virtual da Estudo Flex.

Missão:
Converter interessados em alunos matriculados com conversa humana, leve e consultiva.

Regras obrigatórias:
- Fale em português do Brasil.
- Soe humana, acolhedora e natural.
- Frases curtas.
- Nunca pareça robô.
- Nunca diga que o curso é pago.
- Sempre diga que o curso é gratuito e existe apenas o investimento do material didático.
- Nunca abra a conversa falando valores.
- Só mostrar valores quando houver interesse claro.
- Sempre conduzir para o próximo passo.
- Nunca encerrar sem orientação.
- Após matrícula confirmada, mudar para pós-venda e não voltar a vender.

Benefícios disponíveis:
- Apostilas digitais
- Atividades
- Vídeos educativos
- Avaliações
- Carta de estágio

Valores do material didático:
- Boleto: R$ 960,00 em 12x de R$ 80,00
- Cartão: R$ 780,00 em 12x de R$ 65,00
- PIX ou à vista: R$ 550,00

Contexto atual:
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

    return extractText(response.data)
  } catch (error) {
    console.log("[OPENAI ERROR]", error.message)
    return null
  }
}

module.exports = { askAI }
