# Revisão de PRs e exceção para administradores

O GitHub não permite que o autor registre aprovação na própria PR. Para atender
ao fluxo educacional de um mantenedor, somente administradores podem dispensar
a revisão ao fazer merge de uma PR, inclusive de sua própria autoria. Não há
autoaprovação registrada ou compartilhamento de conta.

| Papel efetivo no repo | Merge sem aprovação de CODEOWNER | CI obrigatório | PR obrigatória |
| --- | --- | --- | --- |
| Admin | Permitido, usando a exceção de revisão. | Sim | Sim |
| Maintain ou Write | Não permitido. | Sim | Sim |
| Triage ou Read | Não concede permissão de merge. | Sim | Sim |

A exceção segue o papel admin, inclusive para futuros administradores; não é uma
lista fixa de logins. A dispensa pode ser usada por admins em qualquer PR elegível,
inclusive nas próprias. O GitHub não oferece essa exceção condicionada apenas à
autoria. Novas concessões de admin precisam ser tratadas como acesso privilegiado.

## Configuração aplicada à main

A revisão está no [ruleset main-reviews-admin-exception](https://github.com/carlosribeirodev/sap-btp-infra/rules/27005805).
Sua definição fica em [main-reviews.json](../.github/rulesets/main-reviews.json):

- Uma aprovação, revisão de CODEOWNER e aprovação do último push para não admins.
- Aprovações descartadas após novos commits e resolução das conversas exigida.
- Único bypass: `RepositoryRole`, ID `5` (admin), modo `pull_request`.
- Sem exceções para usuários individuais, outros papéis, times ou apps.

O modo `pull_request` restringe a exceção ao merge de PRs. Ele não libera push
direto na main. A proteção clássica permanece com `enforce_admins: true` e exige:

- Check **Validate catalog and provisioner**, do app GitHub Actions, aprovado.
- Branch atualizada, conversas resolvidas e histórico linear.
- Force push e exclusão bloqueados.

A revisão clássica duplicada foi removida somente depois de validar o ruleset
ativo. Todas as demais propriedades da proteção clássica foram preservadas e
comparadas antes/depois. Não desativar `enforce_admins` para obter essa exceção,
pois isso também poderia dispensar outros controles.

## Operação e verificação

O fluxo continua clone, branch, push e PR. Colaboradores sem admin aguardam a
aprovação de CODEOWNER. Admins podem concluir a PR depois do CI, usando a opção
administrativa de dispensa da revisão apresentada pelo GitHub. A decisão fica
associada à conta que fez o merge; nenhuma revisão fictícia é criada.

```sh
gh api repos/carlosribeirodev/sap-btp-infra/rulesets/27005805
gh api repos/carlosribeirodev/sap-btp-infra/branches/main/protection
```

As regras da API são o estado efetivo. Alterar o JSON no Git não aplica mudanças
automaticamente ao GitHub. Esta configuração também não concede acesso ao BTP ou
habilita entrega automática; o merge continua executando somente CI.

## Referências

- [GitHub — Autores não podem aprovar as próprias PRs](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/approving-a-pull-request-with-required-reviews).
- [GitHub — Rulesets e exceção somente por PR](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository).
- [GitHub — API de rulesets](https://docs.github.com/en/rest/repos/rules).
