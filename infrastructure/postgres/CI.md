# CI, revisão e preparação da entrega

## Fluxo da equipe

Colaboradores com Write usam clone, branch no próprio repo, push e PR para main.
O mantenedor concede o acesso a contas ou times definidos; tornar o repo público
não concede escrita. Contribuições externas podem usar fork. O
[guia de contribuição](../../CONTRIBUTING.md) demonstra o pedido completo.

## CI

O [workflow](../../.github/workflows/postgres-catalog-ci.yml) roda em PRs para main,
pushes para main e acionamento manual, sem filtro de caminhos. O job
**Validate catalog and provisioner** usa Ubuntu 24.04, Python 3.12, Node.js 24.22.2 e
PostgreSQL 16 efêmero para executar:

1. Validação do catálogo e publicação do plano offline no resumo.
2. 19 testes Python do contrato, das políticas e da orquestração.
3. 3 testes do cliente Credential Store com transporte simulado.
4. 17 testes de alocação, isolamento e retomada num PostgreSQL local temporário.

As actions são fixadas por SHA; o token tem `contents: read` e a credencial do
checkout não é persistida. O CI não recebe secrets BTP, nem instala CF CLI ou executa
`bootstrap`, `apply` e `check` na nuvem. O cluster de teste é removido ao terminar.

## Proteção de main

A configuração deste exercício exige:

- PR com uma aprovação de CODEOWNER para não administradores; propriedade em `.github/CODEOWNERS`.
- Check **Validate catalog and provisioner** aprovado e branch atualizada.
- Descarte de aprovações após novos commits e aprovação por alguém diferente do
  autor do último push.
- Resolução de conversas, histórico linear e CI obrigatório também para administradores.
- Force push e exclusão de main bloqueados.

O CODEOWNER inicial é `CarlosRibeiro82`. O GitHub não permite registrar aprovação
na própria PR. Somente admins podem dispensar revisão no merge, inclusive em PRs
próprias; Write e Maintain continuam exigindo aprovação independente. O CI não é
dispensado. A regra de revisão está num ruleset com exceção admin somente via PR;
a proteção clássica mantém CI e os demais controles para todos.
Ver [definições e verificação](../../docs/governance.md).

Essas proteções estão disponíveis para repositórios públicos no GitHub Free. As
regras são configurações da API do GitHub, não efeitos automáticos deste arquivo.
O mantenedor pode conferi-las em Settings → Branches e com:

```sh
gh api repos/carlosribeirodev/sap-btp-infra/branches/main/protection
```

## Identidade técnica e entrega futura

A conta técnica ainda precisa ser criada no IdP usado para usuários de plataforma
CF. O nome operacional sugerido é `btp-postgres-ci-dev`; o login real e a origin
dependem do provedor. Uma identidade somente de aplicação/XSUAA não equivale ao
usuário da API Cloud Foundry.

Um administrador atribui Space Developer somente no space dev do exercício, usando
os nomes reais de usuário, org e origin:

```sh
cf set-space-role 'TECHNICAL_USER' 'ORG_NAME' dev SpaceDeveloper --origin 'ORIGIN_KEY'
```

Usar a origin correta ou omitir `--origin` quando o fluxo padrão se aplicar.
Validar autenticação não interativa e destino num perfil CF isolado. A CLI aceita
`CF_USERNAME` e `CF_PASSWORD` no ambiente para `cf auth`; não passar senha em
argumentos, YAML ou mensagens.

Antes de habilitar entrega, revisar um workflow separado, serializado por destino,
com environment protegido, credenciais liberadas somente para main e identidade
técnica com escopo definido. O fluxo atual não usa essas credenciais. Os secrets
SQL continuam no cofre; não precisam ser cadastrados manualmente no GitHub.

O deploy CAP ainda precisa adaptar manifests/startup e consumir a credencial do
app. Um CI verde não publica API, AppRouter, XSUAA ou modelos de negócio.
A [tabela de compatibilidade do projeto CAP](https://github.com/carlosribeirodev/sap-cap-postgres-cloud-foundry/blob/main/docs/infrastructure-catalog.md)
registra as diferenças entre o catálogo e os scripts da reprodução anterior.

## Referências

- [GitHub — Proteção de branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).
- [GitHub — Permissões por repositório](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization).
- [GitHub — Segurança de runners](https://docs.github.com/en/actions/concepts/security/compromised-runners).
- [SAP — Usuário técnico em pipelines CF](https://help.sap.com/docs/continuous-integration-and-delivery/sap-continuous-integration-and-delivery/configure-sap-cloud-application-programming-model-job-in-your-repository).
