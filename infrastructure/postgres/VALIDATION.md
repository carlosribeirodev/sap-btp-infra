# Validação e limites

## Suítes reproduzíveis

O projeto inclui 39 testes: 19 Python, 3 do cliente Credential Store e 17 com
PostgreSQL 16 real e cofre simulado. O CI usa Python 3.12 e Node.js 24.22.2. Os
comandos locais estão no [guia de operação](README.md).

Os testes cobrem contrato e rejeição de campos indevidos, ampliação do catálogo
com um terceiro app, plano sem sessão CF, ausência de fallback pago, propriedade
de serviços, escopo dos bindings e cleanup de falhas. As suítes Node cobrem JWE,
mTLS/configuração de transporte, escritas condicionais no cofre, CRUD/sequences,
isolamento, retomada e recusa de drift ou recursos sem registro.

O teste de duas alocações usa um catálogo isolado. A suíte não fixa a quantidade
de solicitações do catálogo publicado; novos apps aprovados podem ser adicionados
sem alterar os testes. O PostgreSQL de integração usa porta aleatória em 127.0.0.1
e é encerrado e removido ao terminar. O provisionador SQL é exercitado sem SUPERUSER.

O histórico público está no
[GitHub Actions](https://github.com/carlosribeirodev/sap-btp-infra/actions/workflows/postgres-catalog-ci.yml).

## Evidência pública do fluxo por branch e PR — 2026-11-11

- [CI inicial da main](https://github.com/carlosribeirodev/sap-btp-infra/actions/runs/42937263146): aprovado no commit `7bb4fe1`.
- [PR de um terceiro app sintético](https://github.com/carlosribeirodev/sap-btp-infra/pull/1): branch publicada no próprio repo, sem fork.
- [CI dessa PR](https://github.com/carlosribeirodev/sap-btp-infra/actions/runs/42937432744): aprovado com os 39 testes e catálogo ampliado.

Mesmo com CI verde, a API retornou `REVIEW_REQUIRED` e `BLOCKED`, confirmando a
exigência de revisão. CODEOWNERS foi validado sem erros; as regras se aplicam a
administradores. A PR foi fechada sem merge e sua branch temporária foi removida.
O pedido sintético não foi aplicado no BTP.

## Validação anterior com serviços BTP

A implementação base foi exercitada pelo mantenedor num ambiente de laboratório,
com bootstrap, duas execuções de apply e checks restritos para Requests e Assets.
Foram confirmados isolamento SQL, escrita/leitura no cofre e cleanup dos recursos
temporários. Essa evidência de operação manual não equivale a uma entrega pelo CI.
O repositório público não contém inventário da conta ou logs operacionais.

## Limites

O merge executa somente CI. A entrega automática, a conta técnica e a adaptação do
deploy CAP permanecem pendentes. Rotação de senha, renovação de bindings e
certificados, alteração de identidade e exclusão de recursos não são automatizadas.
Remover um pedido mantém os dados.
A [integração do runtime CAP](https://github.com/carlosribeirodev/sap-cap-postgres-cloud-foundry/blob/main/docs/infrastructure-catalog.md)
continua pendente; os nomes e scripts da reprodução anterior não são intercambiáveis
com as alocações deste catálogo.

O plano offline não consulta serviços remotos ou drift, não aplica quotas rígidas
de conexões e não prevê cobrança. O MVP aceita somente os perfis trial declarados;
a disponibilidade de planos e quotas depende do ambiente real.
