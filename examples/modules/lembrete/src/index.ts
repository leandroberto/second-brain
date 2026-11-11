import { defineModule } from "@brain/module-sdk";
import { z } from "zod";

/** Um lembrete do dia. O `id` é derivado do dia local, então a mesma ocorrência nunca gera dois itens. */
interface Item { id: string; dia: string; texto: string; feito: boolean; criado: string }

const ARQUIVO = "itens.json";

const configSchema = z.object({
  horario: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "horario deve estar no formato HH:MM"),
});

/** AAAA-MM-DD no fuso da máquina: é o "dia" da ocorrência, a chave de idempotência da tarefa. */
const diaLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const pendentes = (itens: Item[]) => itens.filter((i) => !i.feito).length;

const entradaListar = z.object({ pendentes: z.boolean().optional() });

export default defineModule({
  sdk: 1,
  id: "lembrete",
  nome: "Lembretes",
  versao: "0.1.0",
  configSchema,
  aba: { titulo: "Lembretes", pasta: "ui" },

  rotas: [
    {
      metodo: "GET",
      caminho: "/itens",
      async rodar(_req, ctx) {
        return { itens: ctx.estado.lerJson<Item[]>(ARQUIVO) ?? [] };
      },
    },
    {
      // ação do dono: `humano: true` faz o SB recusar o api-token antes de chamar o handler
      metodo: "POST",
      caminho: "/itens/:id/feito",
      humano: true,
      async rodar(req, ctx) {
        return ctx.estado.lock(ARQUIVO, async () => {
          const itens = ctx.estado.lerJson<Item[]>(ARQUIVO) ?? [];
          const item = itens.find((i) => i.id === req.params.id);
          // o SDK não escolhe o status HTTP: o "não encontrado" volta no corpo
          if (!item) return { ok: false, erro: "item não encontrado" };
          item.feito = true;
          ctx.estado.gravarJson(ARQUIVO, itens);
          ctx.badge(pendentes(itens));
          return { ok: true, item };
        });
      },
    },
  ],

  tarefas: [
    {
      id: "diario",
      quando: "0 10 * * *",
      recuperar: true,
      async rodar(ctx) {
        const dia = diaLocal(ctx.ocorrencia);
        const id = `dia-${dia}`;
        const { itens, criou } = await ctx.estado.lock(ARQUIVO, async () => {
          const atuais = ctx.estado.lerJson<Item[]>(ARQUIVO) ?? [];
          // idempotente por ocorrência: rodar de novo para o mesmo dia não cria nem avisa de novo
          if (atuais.some((i) => i.id === id)) return { itens: atuais, criou: false };
          const horario = (ctx.config as z.infer<typeof configSchema>).horario;
          const proximos = [...atuais, { id, dia, texto: `Lembrete de ${dia} (${horario})`, feito: false, criado: new Date().toISOString() }];
          ctx.estado.gravarJson(ARQUIVO, proximos);
          return { itens: proximos, criou: true };
        });
        if (criou) {
          // IA é opcional: sem motor, sem login do Claude ou acima do teto diário, o aviso sai sem corpo
          const ia = await ctx.ia.completar({ prompt: `Escreva uma frase curta de incentivo para o dia ${dia}.`, timeoutS: 30 });
          const corpo = ia.ok && typeof ia.dados === "string" ? ia.dados : undefined;
          await ctx.avisar({ titulo: "Lembrete do dia", corpo, link: `item/${id}`, chave: `dia-${dia}` });
        }
        ctx.badge(pendentes(itens));
      },
    },
  ],

  ferramentasMcp: [
    {
      nome: "listar",
      descricao: "Lista os lembretes (todos, ou só os pendentes).",
      entrada: entradaListar,
      entradaJson: z.toJSONSchema(entradaListar) as Record<string, unknown>,
      async rodar(args, ctx) {
        const { pendentes: soPendentes } = args as z.infer<typeof entradaListar>;
        const itens = ctx.estado.lerJson<Item[]>(ARQUIVO) ?? [];
        return { itens: soPendentes ? itens.filter((i) => !i.feito) : itens };
      },
    },
  ],
});
