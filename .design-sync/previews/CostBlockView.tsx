import { CostBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const TurnCost = () => (
  <div style={frame}>
    <CostBlockView
      block={{
        type: 'cost',
        total_tokens: 18420,
        estimated_cost: 0.214,
      }}
    />
  </div>
);

export const WithSessionTotal = () => (
  <div style={frame}>
    <CostBlockView
      block={{
        type: 'cost',
        input_tokens: 14860,
        output_tokens: 3560,
        total_tokens: 18420,
        estimated_cost: 0.214,
        session_total_cost: 1.872,
      }}
    />
  </div>
);

export const CheapTurn = () => (
  <div style={frame}>
    <CostBlockView
      block={{
        type: 'cost',
        total_tokens: 942,
        estimated_cost: 0.008,
      }}
    />
  </div>
);
