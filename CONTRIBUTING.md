# Solicitar uma alocação PostgreSQL

## Acesso e branch

O mantenedor concede **Write** individualmente, ou por um time da organização, aos
desenvolvedores autorizados. A visibilidade pública permite leitura; ela não
concede push. Cada desenvolvedor usa sua própria conta GitHub.

O fluxo da equipe é clone, branch no mesmo repositório, push e PR:

```sh
git clone https://github.com/carlosribeirodev/sap-btp-infra.git
cd sap-btp-infra
git switch -c postgres/pedidos
```

Para uma cópia existente, partir de main atualizada antes de criar a branch:

```sh
git switch main
git pull --ff-only origin main
git switch -c postgres/pedidos
```

Contribuidores externos sem Write podem usar fork e PR. O fluxo por branch é o
padrão para a equipe autorizada; nenhuma conta recebe acesso automaticamente.

## 1. Registrar o app com a plataforma

O exemplo usa o app `pedidos`. Dentro de `applications` em
`infrastructure/postgres/platform/registry.json`, adicionar:

```json
"pedidos": {
  "owner": "lab",
  "repository": "sua-org/seu-repositorio",
  "source_path": "apps/pedidos",
  "environments": ["dev"]
}
```

Substituir repositório e diretório pelos valores corretos; usar `.` se o código
ficar na raiz. Preservar os registros existentes e as vírgulas do JSON.
O registro é controlado pela plataforma: essa alteração pode acompanhar a PR do
pedido, mas precisa da revisão do CODEOWNER. Apps já cadastrados reutilizam seu
registro. Não trocar a identidade de alocações existentes como parte de um pedido.

## 2. Declarar o pedido

Criar `infrastructure/postgres/catalog/dev/pedidos.json`:

```json
{
  "api_version": 1,
  "app_id": "pedidos",
  "owner": "lab",
  "environment": "dev",
  "postgres": {
    "profile": "shared-dev",
    "connection_pool_max": 5
  },
  "lifecycle": {
    "deletion_policy": "retain"
  }
}
```

Nome do arquivo, app e ambiente precisam coincidir. O perfil permite pool de até
cinco conexões por processo; o provisionador não configura automaticamente o pool
no app. Não há campo de senha, SQL ou nome arbitrário de banco/usuário. Remover um
pedido preserva dados; não existe exclusão automática.

Para `pedidos`, os nomes derivados são:

| Recurso | Nome |
| --- | --- |
| Banco lógico | `cap_lab_dev_pedidos` |
| Schema | `pedidos` |
| Namespace runtime no cofre | `cap-lab-dev-pedidos-runtime` |
| Namespace deployer no cofre | `cap-lab-dev-pedidos-deployer` |

## 3. Validar e publicar a branch

Com Python e as dependências preparados conforme o README:

```sh
cd infrastructure/postgres
python3 provision.py plan
cd ../..
git add infrastructure/postgres/platform/registry.json infrastructure/postgres/catalog/dev/pedidos.json
git commit -m 'Add PostgreSQL request for pedidos'
git push -u origin postgres/pedidos
gh pr create --base main --head postgres/pedidos --title 'Request PostgreSQL for pedidos' --body 'Register pedidos and request a retained shared-dev allocation.'
```

Também é possível abrir a PR pela interface do GitHub. Conferir o plano no resumo
do job **Validate catalog and provisioner**. O CI valida todos os pedidos e executa
as suítes sem acessar o BTP. Uma PR inválida precisa ser corrigida na mesma branch.

## 4. Revisão e aplicação

Main exige o check do CI, branch atualizada, uma aprovação de CODEOWNER e resolução
das conversas. Novos commits invalidam aprovações anteriores. Os controles também
se aplicam a administradores; o autor não aprova a própria PR. O mantenedor precisa
de outro CODEOWNER elegível para integrar PRs de sua própria autoria.

Após o merge, nesta etapa o operador aplica manualmente a revisão aprovada usando
os comandos do [guia de operação](infrastructure/postgres/README.md). O CI verde
não significa que o banco foi criado. O deploy da aplicação é uma etapa separada.

Mudanças em scripts, workflows, schemas e políticas seguem a mesma revisão. O
projeto não contém credenciais de plataforma, dados reais ou configuração de conta.

Alterações somente de documentação também seguem branch, CI e revisão. Com o
CODEOWNER inicial como autor da PR, o merge fica bloqueado até existir uma revisão
de CODEOWNER elegível; Write sozinho não substitui a aprovação exigida.
