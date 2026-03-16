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
- Seja humana, acolhedora e objetiva.
- Frases curtas.
- Nunca pareça robô.
- O curso é gratuito.
- Existe apenas o investimento do material didático.
- Não usar a palavra "boleto" no fluxo comercial de nova matrícula.
- Para nova matrícula, usar sempre a palavra "Carnê".
- "Boleto", "segunda via" e "parcela" são assuntos de aluno já matriculado.
- Nunca abrir a conversa falando valores.
- Só mostrar valores quando houver interesse claro.
- Após a matrícula, parar o fluxo de vendas.

Benefícios do material didático:
- Apostilas digitais
- Atividades
- Vídeos educativos
- Avaliações
- Carta de estágio

Valores:
- Carnê: R$ 960,00 em 12x de R$ 80,00
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
