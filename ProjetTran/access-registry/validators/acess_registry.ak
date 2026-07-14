use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use cardano/address.{Address}
use cardano/assets.{PolicyId, Value, policies}
use cardano/transaction.{InlineDatum, OutputReference, Transaction}

pub type Registry {
  chief: VerificationKeyHash,
  devices: List<VerificationKeyHash>,
  receiver: Address,
  proposed_receiver: Option<Address>,
  version: Int,
}

pub type Action {
  Submit
  ProposeReceiver(Address)
  ApproveProposal
  AuthorizeDevice(VerificationKeyHash)
  RevokeDevice(VerificationKeyHash)
}

/// state_token_policy identifica o NFT único que carrega o estado do registro.
validator access_registry(state_token_policy: PolicyId) {
  spend(optional_datum: Option<Registry>, action: Action, own_ref: OutputReference, self: Transaction) {
    expect Some(state) = optional_datum
    expect Some(own_input) = list.find(self.inputs, fn(input) { input.output_reference == own_ref })

    let has_state_token = list.has(policies(own_input.output.value), state_token_policy)
    let chief_signed = list.has(self.extra_signatories, state.chief)
    let device_signed = list.any(
      self.extra_signatories,
      fn(signer) { device_is_authorized(state.devices, signer) },
    )

    when action is {
      Submit ->
        has_state_token && device_signed && pays_receiver(self, state.receiver)
          && forwards_state(self, own_input.output.address, own_input.output.value, state, state_token_policy)

      ProposeReceiver(next_receiver) ->
        has_state_token && device_signed
          && forwards_state(self, own_input.output.address, own_input.output.value,
            Registry { chief: state.chief, devices: state.devices, receiver: state.receiver,
              proposed_receiver: Some(next_receiver), version: state.version + 1 }, state_token_policy)

      ApproveProposal ->
        when state.proposed_receiver is {
          Some(next_receiver) -> has_state_token && chief_signed
            && forwards_state(self, own_input.output.address, own_input.output.value,
              Registry { chief: state.chief, devices: state.devices, receiver: next_receiver,
                proposed_receiver: None, version: state.version + 1 }, state_token_policy)
          None -> False
        }

      AuthorizeDevice(device) ->
        has_state_token && chief_signed && !list.has(state.devices, device)
          && forwards_state(self, own_input.output.address, own_input.output.value,
            Registry { chief: state.chief, devices: [device, ..state.devices], receiver: state.receiver,
              proposed_receiver: state.proposed_receiver, version: state.version + 1 }, state_token_policy)

      RevokeDevice(device) ->
        has_state_token && chief_signed
          && forwards_state(self, own_input.output.address, own_input.output.value,
            Registry { chief: state.chief, devices: list.filter(state.devices, fn(item) { item != device }), receiver: state.receiver,
              proposed_receiver: state.proposed_receiver, version: state.version + 1 }, state_token_policy)
    }
  }

  else(_) { fail }
}

fn pays_receiver(self: Transaction, receiver: Address) -> Bool {
  list.any(self.outputs, fn(output) { output.address == receiver })
}

fn device_is_authorized(devices: List<VerificationKeyHash>, signer: VerificationKeyHash) -> Bool {
  list.has(devices, signer)
}

fn forwards_state(self: Transaction, own_address: Address, own_value: Value, next_state: Registry, state_token_policy: PolicyId) -> Bool {
  list.any(self.outputs, fn(output) {
    list.has(policies(output.value), state_token_policy)
      && output.address == own_address
      && output.value == own_value
      && output.datum == InlineDatum(next_state)
  })
}

test authorized_device_is_accepted() {
  let device: VerificationKeyHash = #"b276b4133dfba6d70a2889d3b88863ddb372f870cd1aa2882a274e"
  device_is_authorized([device], device)
}

test revoked_device_is_rejected() {
  let device: VerificationKeyHash = #"b276b4133dfba6d70a2889d3b88863ddb372f870cd1aa2882a274e"
  !device_is_authorized(list.filter([device], fn(item) { item != device }), device)
}
