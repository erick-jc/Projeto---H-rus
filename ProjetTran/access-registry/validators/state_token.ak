use aiken/collection/dict
use aiken/collection/list
use cardano/assets.{PolicyId}
use cardano/transaction.{OutputReference, Transaction}
/// Nome fixo do NFT que identifica o único UTxO de estado do registro.
const state_token_name = #"52454749535452595f5354415445"
/// Política one-shot: só pode mintar uma vez, quando o UTxO bootstrap é gasto.
validator state_token(bootstrap_ref: OutputReference) {
  mint(_redeemer: Data, policy_id: PolicyId, self: Transaction) {
    expect [Pair(asset_name, quantity)] = self.mint
      |> assets.tokens(policy_id)
      |> dict.to_pairs()
    let bootstrap_consumed = list.any(
      self.inputs,
      fn(input) { input.output_reference == bootstrap_ref },
    )
    bootstrap_consumed && asset_name == state_token_name && quantity == 1
  }
  else(_) { fail }
}
